/**
 * The REST client.
 *
 * Three things worth knowing.
 *
 * **Link-header pagination.** Mastodon does not return a cursor in the body. It
 * returns a `Link:` header with `rel="next"` carrying a `max_id`, and the only
 * reliable way to page is to follow it. Take a `limit` and stop at whatever one
 * page returned, and "my last 200 posts" silently returns 40.
 *
 * **Per-instance configuration.** Character limits, media counts and poll sizes
 * are per instance, not constants. See `instance.ts`.
 *
 * **Real rate-limit handling.** Mastodon sends `X-RateLimit-Remaining` and an
 * ISO `X-RateLimit-Reset`, which is more than most APIs give you. Retries here
 * wait for the actual reset rather than guessing.
 */

import { setTimeout as delay } from "node:timers/promises";
import type { Account, Config } from "../config.js";
import { errorFor, MastodonError, TimeoutError } from "./errors.js";

export type CallInit = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, unknown>;
  /** Sent as application/x-www-form-urlencoded, which is what Mastodon expects. */
  form?: Record<string, unknown>;
  /** Sent as multipart, for media uploads. */
  formData?: FormData;
  /** Skip the Authorization header, for the handful of public endpoints. */
  anonymous?: boolean;
};

export type Paged<T> = {
  items: T[];
  /** `max_id` for the next page, taken from the Link header. */
  nextMaxId?: string;
  /** `min_id` for newer items, taken from the Link header. */
  prevMinId?: string;
};

/**
 * Parse `Link: <...max_id=123>; rel="next", <...min_id=456>; rel="prev"`.
 *
 * The ids are what the next request needs. Returning the whole URL would work
 * too, but ids survive being handed back through a tool argument and a URL does
 * not always: some instances sit behind a proxy that rewrites the host.
 */
export function parseLinkHeader(header: string | null): { next?: string; prev?: string } {
  if (!header) return {};
  const out: { next?: string; prev?: string } = {};
  for (const part of header.split(",")) {
    const m = part.match(/<([^>]+)>;\s*rel="?(next|prev)"?/);
    if (!m) continue;
    try {
      const url = new URL(m[1]!);
      if (m[2] === "next") out.next = url.searchParams.get("max_id") ?? undefined;
      else out.prev = url.searchParams.get("min_id") ?? undefined;
    } catch {
      // A malformed Link header is not worth failing the whole call over.
    }
  }
  return out;
}

export class MastodonClient {
  private readonly config: Config;
  private lastRequestAt = 0;

  constructor(config: Config) {
    this.config = config;
  }

  get accounts(): Account[] {
    return this.config.accounts;
  }

  /** A call whose body is the whole answer. */
  async call<T = Record<string, unknown>>(
    account: Account,
    path: string,
    init: CallInit = {},
  ): Promise<T> {
    return (await this.raw<T>(account, path, init)).body;
  }

  /** A call whose answer is a list, with the Link header parsed into ids. */
  async list<T = Record<string, unknown>>(
    account: Account,
    path: string,
    init: CallInit = {},
  ): Promise<Paged<T>> {
    const { body, headers } = await this.raw<T[]>(account, path, init);
    const { next, prev } = parseLinkHeader(headers.get("link"));
    return { items: Array.isArray(body) ? body : [], nextMaxId: next, prevMinId: prev };
  }

  /**
   * Follow `Link: rel="next"` until `max` items or the pages run out.
   *
   * Mastodon caps a page at 40. Asking for "my last 200 posts" is normal, and
   * making the model drive the cursor by hand costs a round trip per page and
   * usually gets abandoned after the first.
   */
  async paginate<T = Record<string, unknown>>(
    account: Account,
    path: string,
    init: CallInit,
    max: number,
    stop?: (item: T) => boolean,
  ): Promise<{ items: T[]; nextMaxId?: string; truncated: boolean }> {
    const items: T[] = [];
    let maxId: string | undefined = init.query?.max_id as string | undefined;
    // A hard ceiling so an instance that keeps returning a next link cannot spin.
    const maxPages = Math.max(1, Math.ceil(max / 40) + 2);

    for (let page = 0; page < maxPages && items.length < max; page++) {
      const wanted = Math.min(40, max - items.length);
      const result: Paged<T> = await this.list<T>(account, path, {
        ...init,
        query: { ...init.query, limit: wanted, max_id: maxId },
      });
      if (result.items.length === 0) return { items, truncated: false };

      for (const item of result.items) {
        if (stop?.(item)) return { items, truncated: false };
        items.push(item);
        if (items.length >= max) break;
      }

      maxId = result.nextMaxId;
      if (!maxId) return { items, truncated: false };
    }

    return { items, nextMaxId: maxId, truncated: Boolean(maxId) };
  }

  /** The one place a request actually leaves the process. */
  private async raw<T>(
    account: Account,
    path: string,
    init: CallInit,
  ): Promise<{ body: T; headers: Headers }> {
    const url = new URL(account.instance + path);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value === undefined || value === null || value === "") continue;
      if (Array.isArray(value)) for (const v of value) url.searchParams.append(`${key}[]`, String(v));
      else url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      "user-agent": this.config.userAgent,
      accept: "application/json",
    };
    if (!init.anonymous) headers.authorization = `Bearer ${account.accessToken}`;

    let body: RequestInit["body"];
    if (init.formData) {
      body = init.formData;
    } else if (init.form) {
      const fd = new URLSearchParams();
      for (const [key, value] of Object.entries(init.form)) {
        if (value === undefined || value === null || value === "") continue;
        // Mastodon takes arrays as repeated `key[]` pairs.
        if (Array.isArray(value)) for (const v of value) fd.append(`${key}[]`, String(v));
        else fd.append(key, String(value));
      }
      body = fd;
      headers["content-type"] = "application/x-www-form-urlencoded";
    }

    const method = init.method ?? (body ? "POST" : "GET");

    let lastError: MastodonError | undefined;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      await this.throttle();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
      let response: Response;
      try {
        response = await fetch(url, { method, headers, body, signal: controller.signal });
      } catch (error) {
        clearTimeout(timer);
        const aborted = (error as Error)?.name === "AbortError";
        lastError = aborted
          ? new TimeoutError(
              `${path} on ${account.instance} did not respond within ${this.config.requestTimeoutMs}ms.`,
              408,
              path,
              account.instance,
            )
          : new MastodonError(
              `Could not reach ${account.instance}: ${(error as Error)?.message ?? String(error)}. Instances are individually operated and go down.`,
              0,
              path,
              account.instance,
            );
        if (attempt < this.config.maxRetries) {
          await delay(backoffMs(attempt));
          continue;
        }
        throw lastError;
      }
      clearTimeout(timer);

      const text = await response.text();

      if (response.ok) {
        let parsed: unknown = {};
        if (text) {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = { raw: text };
          }
        }
        return { body: parsed as T, headers: response.headers };
      }

      const error = errorFor(response.status, path, account.instance, text, response.headers);
      lastError = error;

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === this.config.maxRetries) throw error;

      let waitMs = backoffMs(attempt);
      const reset = response.headers.get("x-ratelimit-reset");
      if (response.status === 429 && reset) {
        const at = Date.parse(reset);
        if (Number.isFinite(at)) waitMs = Math.max(0, at - Date.now()) + 250;
      }
      // A reset five minutes out is not something to sit on inside a tool call.
      if (waitMs > 60_000) throw error;
      await delay(waitMs);
    }

    throw lastError ?? new MastodonError(`${path} failed.`, 0, path, account.instance);
  }

  /** Keep a minimum gap between requests, so a paginating tool stays polite. */
  private async throttle(): Promise<void> {
    const gap = this.config.minRequestIntervalMs;
    if (gap <= 0) return;
    const wait = this.lastRequestAt + gap - Date.now();
    if (wait > 0) await delay(wait);
    this.lastRequestAt = Date.now();
  }
}

/** 400ms, 800ms, 1600ms, with jitter, so parallel callers do not resynchronise. */
function backoffMs(attempt: number): number {
  return 400 * 2 ** attempt + Math.floor(Math.random() * 200);
}
