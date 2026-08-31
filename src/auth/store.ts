/**
 * Where `mastodon-mcp login` puts what it captured.
 *
 * One file, `~/.mastodon-mcp/accounts.json`, mode 0600, holding an array so a
 * second `login` adds an account rather than replacing the first. That is the
 * whole reason this exists rather than telling people to paste a token into an
 * environment variable: a federated network means several accounts on several
 * instances is the normal case, not the exotic one.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Account } from "../config.js";
import { normalizeHandle, normalizeInstance } from "../config.js";

export function storeDir(): string {
  return process.env.MASTODON_MCP_HOME || join(homedir(), ".mastodon-mcp");
}

export function storePath(): string {
  return join(storeDir(), "accounts.json");
}

type Stored = { instance: string; access_token: string; handle: string; saved_at: string };

export function loadStoredAccounts(): Account[] {
  const path = storePath();
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const rows: Stored[] = Array.isArray(parsed) ? (parsed as Stored[]) : [parsed as Stored];
    return rows
      .filter((r) => r && typeof r.instance === "string" && typeof r.access_token === "string")
      .map((r) => ({
        instance: normalizeInstance(r.instance),
        accessToken: r.access_token,
        handle: normalizeHandle(r.handle ?? ""),
      }))
      .filter((a) => a.instance && a.accessToken);
  } catch {
    process.stderr.write(`[mastodon-mcp] ${path} is not readable JSON. Ignoring it.\n`);
    return [];
  }
}

/** Add or replace one account, keyed by instance plus handle. */
export function saveAccount(account: Account): string {
  const dir = storeDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const existing = loadStoredAccounts().filter(
    (a) => !(a.instance === account.instance && a.handle === account.handle),
  );
  const rows: Stored[] = [...existing, account].map((a) => ({
    instance: a.instance,
    access_token: a.accessToken,
    handle: a.handle,
    saved_at: new Date().toISOString(),
  }));

  const path = storePath();
  // The file holds live account tokens, so it is never written world-readable.
  writeFileSync(path, `${JSON.stringify(rows, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/** Remove one account by handle or instance. Returns how many were removed. */
export function removeAccount(needle: string): number {
  const want = normalizeHandle(needle);
  const host = normalizeInstance(needle);
  const before = loadStoredAccounts();
  const after = before.filter((a) => a.handle !== want && a.instance !== host);
  if (after.length === before.length) return 0;

  const rows: Stored[] = after.map((a) => ({
    instance: a.instance,
    access_token: a.accessToken,
    handle: a.handle,
    saved_at: new Date().toISOString(),
  }));
  writeFileSync(storePath(), `${JSON.stringify(rows, null, 2)}\n`, { mode: 0o600 });
  return before.length - after.length;
}
