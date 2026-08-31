/**
 * Resolving credentials, and the multi-account model.
 *
 * Mastodon is federated, so an account is a **token plus an instance**. A token
 * issued by mastodon.social means nothing on fosstodon.org, which is why the
 * instance travels with the token rather than living in one global variable.
 * Both reference servers take a single instance from the environment, so running
 * a personal account and a project account on two different servers means
 * running two copies of the server.
 *
 * Two sources, in priority order:
 *   1. MASTODON_ACCOUNTS  a JSON array, for several accounts across instances
 *   2. MASTODON_URL + MASTODON_ACCESS_TOKEN, the single-account variables
 *   3. ~/.mastodon-mcp/accounts.json, whatever `mastodon-mcp login` captured
 */

import { loadStoredAccounts } from "./auth/store.js";

export type Account = {
  /** Instance base URL, no trailing slash. e.g. https://mastodon.social */
  instance: string;
  accessToken: string;
  /** Full handle, e.g. alice@mastodon.social. Filled in by login or on first use. */
  handle: string;
};

export type Config = {
  accounts: Account[];
  preferred: string[];
  readOnly: boolean;
  allowDestructive: boolean;
  requestTimeoutMs: number;
  minRequestIntervalMs: number;
  maxRetries: number;
  userAgent: string;
  auditPath?: string;
};

/** Strip a scheme, a path and any trailing slash down to a canonical origin. */
export function normalizeInstance(raw: string): string {
  const t = (raw ?? "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
  return t ? `https://${t}` : "";
}

/** Strip a leading @ and lowercase. `alice@example.social` and `@alice` both work. */
export function normalizeHandle(raw: string): string {
  return (raw ?? "").trim().replace(/^@/, "").toLowerCase();
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    process.stderr.write(`[mastodon-mcp] ${name}="${raw}" is not a positive number. Using ${fallback}.\n`);
    return fallback;
  }
  return n;
}

/** Read `MASTODON_ACCOUNTS`, a JSON array. snake_case and camelCase both work. */
export function accountsFromJson(raw: string | undefined): Account[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write("[mastodon-mcp] MASTODON_ACCOUNTS is not valid JSON. Ignoring it.\n");
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: Account[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const instance = e.instance ?? e.url ?? e.api_base_url ?? e.apiBaseUrl;
    const token = e.access_token ?? e.accessToken ?? e.token;
    if (typeof instance !== "string" || typeof token !== "string") continue;
    const url = normalizeInstance(instance);
    if (!url || !token.trim()) continue;
    const handle = e.handle ?? e.acct ?? e.account_name;
    out.push({
      instance: url,
      accessToken: token.trim(),
      handle: typeof handle === "string" ? normalizeHandle(handle) : "",
    });
  }
  return out;
}

function accountFromSingleEnv(): Account[] {
  const instance = normalizeInstance(
    process.env.MASTODON_URL || process.env.MASTODON_INSTANCE_URL || process.env.MASTODON_API_BASE_URL || "",
  );
  const token = process.env.MASTODON_ACCESS_TOKEN;
  if (!instance || !token) return [];
  return [{ instance, accessToken: token.trim(), handle: normalizeHandle(process.env.MASTODON_HANDLE ?? "") }];
}

export function loadConfig(): Config {
  const fromJson = accountsFromJson(process.env.MASTODON_ACCOUNTS);
  const accounts = fromJson.length
    ? fromJson
    : accountFromSingleEnv().length
      ? accountFromSingleEnv()
      : loadStoredAccounts();

  const preferred = (process.env.MASTODON_DEFAULT_ACCOUNT ?? "")
    .split(",")
    .map((s) => normalizeHandle(s))
    .filter(Boolean);

  return {
    accounts,
    preferred,
    readOnly: envFlag("MASTODON_READ_ONLY", false),
    allowDestructive: envFlag("MASTODON_ALLOW_DESTRUCTIVE", true),
    requestTimeoutMs: envInt("MASTODON_REQUEST_TIMEOUT_MS", 30_000),
    minRequestIntervalMs: envInt("MASTODON_MIN_REQUEST_INTERVAL_MS", 120),
    maxRetries: envInt("MASTODON_MAX_RETRIES", 3),
    userAgent: process.env.MASTODON_USER_AGENT || "mastodon-mcp",
    auditPath: process.env.MASTODON_AUDIT_LOG || undefined,
  };
}

/**
 * Pick which account a call acts as.
 *
 * A hint matches a full handle (`alice@example.social`), a bare username
 * (`alice`), or an instance (`example.social`). Exact beats prefix, so two
 * accounts whose names share a prefix cannot be confused for each other.
 */
export function selectAccount(config: Config, hint?: string): Account {
  if (config.accounts.length === 0) {
    throw new Error(
      "No Mastodon account configured. Run `mastodon-mcp login <your-instance>` to register an app and sign in, or set MASTODON_URL and MASTODON_ACCESS_TOKEN. Run `mastodon-mcp doctor` for details.",
    );
  }

  if (!hint) {
    for (const want of config.preferred) {
      const exact = config.accounts.find((a) => a.handle === want);
      if (exact) return exact;
      const prefix = config.accounts.filter((a) => a.handle.startsWith(want));
      if (prefix.length === 1) return prefix[0]!;
    }
    return config.accounts[0]!;
  }

  const needle = normalizeHandle(hint);

  const exact = config.accounts.find((a) => a.handle === needle);
  if (exact) return exact;

  // A bare username, when only one account uses it.
  const byUser = config.accounts.filter((a) => a.handle.split("@")[0] === needle);
  if (byUser.length === 1) return byUser[0]!;

  // An instance, when only one account lives there.
  const host = normalizeInstance(needle);
  const byInstance = config.accounts.filter((a) => a.instance === host);
  if (byInstance.length === 1) return byInstance[0]!;

  // A prefix match, but only when it is unambiguous. Silently picking the first
  // of two accounts whose handles share a prefix is how a post lands on the
  // wrong one, and on a federated network "alice" really can be two people.
  const prefix = config.accounts.filter((a) => a.handle.startsWith(needle));
  if (prefix.length === 1) return prefix[0]!;

  const known = config.accounts.map((a) => a.handle || a.instance).join(", ");
  throw new Error(
    `No connected Mastodon account matches "${hint}". Connected: ${known || "(none)"}`,
  );
}
