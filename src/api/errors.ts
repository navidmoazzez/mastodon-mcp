/**
 * Typed errors for every way a Mastodon call can fail.
 *
 * Mastodon returns `{"error": "..."}` and sometimes `{"error_description": "..."}`,
 * and the useful part is usually the status. 401 means the token is wrong or was
 * revoked. 403 more often means the token is missing a **scope** than that the
 * action is forbidden, and that distinction is the difference between "sign in
 * again" and "you cannot do this". Both reference servers surface a bare string
 * for all of it.
 *
 * 429 is worth its own class here because Mastodon sends real
 * `X-RateLimit-Remaining` and `X-RateLimit-Reset` headers, unlike most APIs,
 * and the reset is an ISO timestamp rather than a number of seconds.
 */

export class MastodonError extends Error {
  readonly status: number;
  readonly endpoint: string;
  readonly instance: string;
  readonly detail: string;

  constructor(message: string, status: number, endpoint: string, instance = "", detail = "") {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.endpoint = endpoint;
    this.instance = instance;
    this.detail = detail;
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.message,
      type: this.name,
      status: this.status,
      endpoint: this.endpoint,
      ...(this.instance ? { instance: this.instance } : {}),
      ...(this.detail ? { detail: this.detail } : {}),
    };
  }
}

/** 401. The token is invalid, revoked, or from a different instance. */
export class AuthenticationError extends MastodonError {}

/** 403. Usually a missing OAuth scope rather than a genuinely forbidden action. */
export class ForbiddenError extends MastodonError {}

/** 422. Mastodon's validation failure, e.g. a status over the character limit. */
export class ValidationError extends MastodonError {}

/** 404. Gone, never existed, or on an instance this one cannot see. */
export class NotFoundError extends MastodonError {}

/** 429, carrying the reset time when the instance sent one. */
export class RateLimitError extends MastodonError {
  readonly resetAt?: string;

  constructor(
    message: string,
    status: number,
    endpoint: string,
    instance: string,
    detail: string,
    resetAt?: string,
  ) {
    super(message, status, endpoint, instance, detail);
    this.resetAt = resetAt;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), ...(this.resetAt ? { reset_at: this.resetAt } : {}) };
  }
}

/** 5xx, or an instance that is simply down. Federation means this is routine. */
export class ServerError extends MastodonError {}

/** Synthetic 408. Nothing arrived before our own deadline. */
export class TimeoutError extends MastodonError {}

/** Writes are disabled, or a destructive tool was called without `confirm`. */
export class WriteBlockedError extends MastodonError {
  constructor(message: string) {
    super(message, 0, "(local)", "", "");
  }
}

/** Pull `{error, error_description}` out of a response body. */
export function parseErrorBody(body: string): string {
  const text = body.trim();
  if (!text) return "";
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const parts = [parsed.error, parsed.error_description]
      .filter((v): v is string => typeof v === "string" && Boolean(v));
    if (parts.length) return [...new Set(parts)].join(": ").slice(0, 500);
  } catch {
    // Not JSON. An instance behind a proxy can answer with an HTML page.
  }
  return text.replace(/\s+/g, " ").slice(0, 500);
}

/** Map a status onto the right class, with a message naming the actual fix. */
export function errorFor(
  status: number,
  endpoint: string,
  instance: string,
  body: string,
  headers?: Headers,
): MastodonError {
  const detail = parseErrorBody(body);

  if (status === 429) {
    const reset = headers?.get("x-ratelimit-reset") ?? undefined;
    const when = reset ? ` The limit resets at ${reset}.` : "";
    return new RateLimitError(
      `${instance} rate limited ${endpoint}. The client already backs off and retries; this failed after the last attempt.${when}`,
      status,
      endpoint,
      instance,
      detail,
      reset,
    );
  }
  if (status === 401) {
    return new AuthenticationError(
      `${instance} rejected the access token for ${endpoint}. It has been revoked, or it belongs to a different instance. Run \`mastodon-mcp login ${instance.replace(/^https?:\/\//, "")}\` to get a new one.`,
      status,
      endpoint,
      instance,
      detail,
    );
  }
  if (status === 403) {
    return new ForbiddenError(
      `${instance} refused ${endpoint}. This is usually a missing OAuth scope rather than a forbidden action: re-run \`mastodon-mcp login\` so the token is granted read, write and follow.`,
      status,
      endpoint,
      instance,
      detail,
    );
  }
  if (status === 422) {
    return new ValidationError(
      `${instance} rejected the arguments sent to ${endpoint}.`,
      status,
      endpoint,
      instance,
      detail,
    );
  }
  if (status === 404 || status === 410) {
    return new NotFoundError(
      `Not found on ${instance} via ${endpoint}. On a federated network this can also mean the post exists elsewhere but this instance has never fetched it. Searching for its URL with resolve enabled usually pulls it in.`,
      status,
      endpoint,
      instance,
      detail,
    );
  }
  if (status >= 500) {
    return new ServerError(
      `${instance} returned ${status} for ${endpoint}. Instances are individually operated, so this is usually that one server having a bad day.`,
      status,
      endpoint,
      instance,
      detail,
    );
  }
  return new MastodonError(`${instance} returned ${status} for ${endpoint}.`, status, endpoint, instance, detail);
}
