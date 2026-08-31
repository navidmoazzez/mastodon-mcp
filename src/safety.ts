/**
 * Decides whether a write is allowed to reach Mastodon.
 *
 * The two reference servers take opposite positions and neither is right.
 * berlinbra's ships no writes at all and calls that safety, which just moves
 * the work back to the human. brianellin's ships `create-post`, `like-post` and
 * `follow-user` completely unguarded, so a model that misreads "clean up my
 * feed" posts publicly on the first try.
 *
 * The hazard here is specific and worth naming. A post is public the instant it
 * lands, and deleting it does not pull it out of the feeds, caches and clients
 * that already have it. An unsend does not exist. A delete is likewise final.
 * Neither is dangerous when a human meant it.
 *
 * So: everything works, and the operations that reach other people need an
 * explicit `confirm: true` the model has to set deliberately after reading the
 * tool description. That is a speed bump a careless call trips over and an
 * intentional one clears in one retry. Likes, reposts and follows are one
 * click to undo and are not guarded. A confirm on every like would train the
 * model to pass confirm reflexively, which is worse than not asking.
 *
 * MASTODON_READ_ONLY=1 removes every write from the tool list entirely, for
 * pointing an untrusted agent at an account.
 */

import { appendFileSync } from "node:fs";
import type { Config } from "./config.js";
import { WriteBlockedError } from "./api/errors.js";

export type Risk =
  /** Reads public data, or your own. */
  | "read"
  /** Changes something reversible: a like, a follow, a mute. */
  | "write"
  /** Public the moment it runs, or cannot be undone. */
  | "destructive";

export class WriteGuard {
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  get readOnly(): boolean {
    return this.config.readOnly;
  }

  check(tool: string, risk: Risk, confirm: boolean | undefined, summary: string): void {
    if (risk === "read") return;

    if (this.config.readOnly) {
      this.audit(tool, summary, "blocked: read-only");
      throw new WriteBlockedError(
        `${tool} is unavailable: this server is running with MASTODON_READ_ONLY=1.`,
      );
    }

    if (risk === "destructive") {
      if (!this.config.allowDestructive) {
        this.audit(tool, summary, "blocked: destructive disabled");
        throw new WriteBlockedError(
          `${tool} is unavailable: this server is running with MASTODON_ALLOW_DESTRUCTIVE=0.`,
        );
      }
      if (confirm !== true) {
        this.audit(tool, summary, "blocked: no confirm");
        throw new WriteBlockedError(
          `${tool} is public or irreversible, so it will not run without confirm: true. About to: ${summary}. Call again with confirm: true if that is what was asked for.`,
        );
      }
    }

    this.audit(tool, summary, "allowed");
  }

  /** Append-only record of every attempted write, when MASTODON_AUDIT_LOG is set. */
  private audit(tool: string, summary: string, outcome: string): void {
    if (!this.config.auditPath) return;
    const line = JSON.stringify({
      at: new Date().toISOString(),
      tool,
      summary,
      outcome,
    });
    try {
      appendFileSync(this.config.auditPath, `${line}\n`, { mode: 0o600 });
    } catch {
      // A failing audit log must never take the tool call down with it.
    }
  }
}

/**
 * MCP annotations for a risk level.
 *
 * Clients use these to decide what to auto-approve, so they have to be honest:
 * `openWorldHint` is true for everything because every call leaves the machine,
 * and `idempotentHint` is false for a post because calling it twice posts twice.
 */
export function annotationsFor(
  risk: Risk,
  options: { public?: boolean; idempotent?: boolean } = {},
): Record<string, boolean> {
  return {
    readOnlyHint: risk === "read",
    destructiveHint: risk === "destructive",
    idempotentHint: options.idempotent ?? risk === "read",
    openWorldHint: true,
  };
}
