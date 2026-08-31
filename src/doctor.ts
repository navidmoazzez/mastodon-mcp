/**
 * `mastodon-mcp doctor`: say what is wrong, in the order it will break.
 *
 * The failure people actually hit on Mastodon is a token missing the `write`
 * scope. Reads work, so everything looks fine, and then the first post fails
 * with a 403 that says "This action is not allowed" and nothing about scopes.
 * So this checks scopes explicitly, per account, and names the fix.
 */

import { MastodonClient } from "./api/client.js";
import { loadConfig } from "./config.js";
import { instanceLimits } from "./api/instance.js";
import { MastodonError } from "./api/errors.js";
import { storePath } from "./auth/store.js";
import { VERSION } from "./server.js";

type Check = { ok: boolean; label: string; detail?: string };

function line(check: Check): string {
  return `${check.ok ? "  ok  " : " FAIL "} ${check.label}${check.detail ? `\n       ${check.detail}` : ""}`;
}

export async function runDoctor(): Promise<number> {
  const config = loadConfig();
  const client = new MastodonClient(config);
  const checks: Check[] = [];

  process.stdout.write(`mastodon-mcp ${VERSION}\n\n`);

  if (config.accounts.length === 0) {
    process.stdout.write(
      line({
        ok: false,
        label: "no account configured",
        detail: `Run \`mastodon-mcp login mastodon.social\` (or your own instance). It registers the app for you; there is no developer portal to visit. Looked in MASTODON_ACCOUNTS, MASTODON_URL + MASTODON_ACCESS_TOKEN, and ${storePath()}.`,
      }) + "\n",
    );
    return 1;
  }

  checks.push({
    ok: true,
    label: `${config.accounts.length} account${config.accounts.length === 1 ? "" : "s"} configured`,
    detail: config.accounts.map((a) => `${a.handle || "(unverified)"} on ${a.instance}`).join(", "),
  });

  for (const account of config.accounts) {
    const who = account.handle || account.instance;

    // 1. Is the instance reachable, and what does it allow.
    try {
      const limits = await instanceLimits(client, account);
      checks.push({
        ok: true,
        label: `${account.instance} reachable`,
        detail: `${limits.title}, ${limits.version}, ${limits.maxCharacters} characters, ${limits.maxMediaAttachments} attachments, ${limits.maxPollOptions} poll options`,
      });
      if (!limits.looksLikeMastodon) {
        checks.push({
          ok: true,
          label: `${account.instance} is not Mastodon itself`,
          detail: `Reports "${limits.version}". The API is compatible, but edits, polls or trends may be missing.`,
        });
      }
    } catch (error) {
      checks.push({
        ok: false,
        label: `${account.instance} unreachable`,
        detail: (error as Error).message,
      });
      continue;
    }

    // 2. Does the token work, and who is it.
    try {
      const me = await client.call<Record<string, any>>(account, "/api/v1/accounts/verify_credentials");
      checks.push({
        ok: true,
        label: `${who} authenticates`,
        detail: `@${me.acct}, ${me.followers_count ?? 0} followers, ${me.statuses_count ?? 0} statuses`,
      });
    } catch (error) {
      const detail =
        error instanceof MastodonError && error.status === 401
          ? `The token was revoked or belongs to another instance. Run \`mastodon-mcp login ${account.instance.replace(/^https?:\/\//, "")}\`.`
          : (error as Error).message;
      checks.push({ ok: false, label: `${who} fails to authenticate`, detail });
      continue;
    }

    // 3. Which scopes the token actually holds. This is the real trap: a
    //    read-only token passes every check above and then fails on the first
    //    post with a 403 that never mentions scopes.
    try {
      const app = await client.call<Record<string, any>>(account, "/api/v1/apps/verify_credentials");
      const scopes = String(app.scopes ?? "").split(/[\s,]+/).filter(Boolean);
      const granted = scopes.length ? scopes : ["(not reported)"];
      const canWrite = scopes.some((s) => s === "write" || s.startsWith("write:"));
      const canFollow = scopes.some((s) => s === "follow" || s.startsWith("write:follows"));
      checks.push({
        ok: canWrite,
        label: canWrite ? `${who} can post` : `${who} cannot post`,
        detail: canWrite
          ? `scopes: ${granted.join(" ")}`
          : `scopes: ${granted.join(" ")}. The token has no write scope, so reads work and the first post will fail with a 403. Run \`mastodon-mcp login ${account.instance.replace(/^https?:\/\//, "")}\` to get one with read, write and follow.`,
      });
      if (canWrite && !canFollow) {
        checks.push({
          ok: false,
          label: `${who} cannot follow or block`,
          detail: "The token has write but not follow. Re-run login to grant it.",
        });
      }
    } catch {
      // `/apps/verify_credentials` is Mastodon-specific; compatible servers may
      // not have it. Not knowing the scopes is not itself a failure.
      checks.push({
        ok: true,
        label: `${who} scopes not reported`,
        detail: "This server does not expose /api/v1/apps/verify_credentials. Posting may still work.",
      });
    }
  }

  if (config.readOnly) {
    checks.push({ ok: true, label: "MASTODON_READ_ONLY=1: every write is hidden from the tool list" });
  }
  if (!config.allowDestructive) {
    checks.push({ ok: true, label: "MASTODON_ALLOW_DESTRUCTIVE=0: posting and deleting are blocked" });
  }
  if (config.preferred.length) {
    checks.push({ ok: true, label: `default account preference: ${config.preferred.join(", ")}` });
  }

  process.stdout.write(checks.map(line).join("\n") + "\n");
  return checks.every((c) => c.ok) ? 0 : 1;
}
