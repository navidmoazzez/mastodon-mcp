/**
 * Shared plumbing every tool uses.
 *
 * Registering forty tools by hand is forty chances to forget an annotation,
 * leak a stack trace, or return a shape the model cannot read. This wraps all
 * of it once so a tool module only describes what it actually does.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape } from "zod";
import type { MastodonClient } from "../api/client.js";
import { MastodonError } from "../api/errors.js";
import type { Account, Config } from "../config.js";
import { selectAccount } from "../config.js";
import { annotationsFor, type Risk, type WriteGuard } from "../safety.js";

export type ToolContext = {
  client: MastodonClient;
  config: Config;
  guard: WriteGuard;
  /** Resolve which account this call acts as. */
  account: (hint?: string) => Account;
};

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/**
 * A tool returns either a pre-rendered string or a value to serialise.
 *
 * The reading tools return the tagged format from `format/posts.ts`, which is
 * already text. The writing tools return a small object, a URI, a permalink,
 * where JSON is clearer than tags. Both go through here so neither has to think
 * about the MCP content envelope.
 */
export function ok(data: unknown): ToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

/**
 * Errors come back as a normal result with `isError`, not a thrown exception.
 *
 * A thrown MCP error reaches the model as a protocol failure with no structure.
 * A result it can read tells it what went wrong and usually how to fix it,
 * which is the difference between a correct retry and a give-up.
 */
export function fail(error: unknown): ToolResult {
  const payload =
    error instanceof MastodonError
      ? error.toJSON()
      : { error: (error as Error)?.message ?? String(error) };
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

/** The optional argument that picks an account, on every account-scoped tool. */
export const accountArg = {
  account: z
    .string()
    .optional()
    .describe(
      "Which connected account to act as. Matches a full handle (alice@example.social), a bare username (alice), or an instance (example.social). Defaults to the first connected account. Call list_accounts to see them.",
    ),
};

/** The confirmation argument required by every public or irreversible tool. */
export const confirmArg = {
  confirm: z
    .boolean()
    .optional()
    .describe(
      "Must be true for this to run. The result is public immediately or cannot be undone, so it is refused without an explicit confirmation.",
    ),
};

/** Cursor and limit, on every paginating tool. */
export const pageArgs = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("How many to return per page, 1-100."),
  cursor: z
    .string()
    .optional()
    .describe("Continue from a previous page. Pass the `cursor` attribute from the last result."),
};

export type ToolSpec<S extends ZodRawShape> = {
  name: string;
  /** One line, imperative. Shown in tool pickers. */
  title: string;
  description: string;
  schema: S;
  risk: Risk;
  /** True when the effect is visible to anyone but you. */
  public?: boolean;
  /** True when calling twice has the same effect as calling once. */
  idempotent?: boolean;
  handler: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<unknown>;
  /** One line for the audit log and the confirm message, when this is a write. */
  summary?: (args: z.infer<z.ZodObject<S>>) => string;
};

export function defineTool<S extends ZodRawShape>(spec: ToolSpec<S>): ToolSpec<S> {
  return spec;
}

/**
 * A tool of any shape, for the one place tools are held together in a list.
 *
 * `ToolSpec` is generic over its schema, so a list of tools with different
 * schemas has no single type: each handler takes a different argument shape and
 * function parameters are contravariant. The type safety that matters lives
 * inside each `defineTool` call, where schema and handler are checked against
 * each other. This only loosens the seam where they are collected.
 */
export type AnyToolSpec = Omit<ToolSpec<ZodRawShape>, "handler" | "summary"> & {
  handler: (args: never, ctx: ToolContext) => Promise<unknown>;
  summary?: (args: never) => string;
};

/** Register one tool against the server, with guarding and error handling applied. */
export function register(
  server: McpServer,
  contextFor: (extra: unknown) => ToolContext,
  spec: AnyToolSpec,
): void {
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.schema,
      annotations: {
        title: spec.title,
        ...annotationsFor(spec.risk, { public: spec.public, idempotent: spec.idempotent }),
      },
    },
    // The SDK derives its callback type from the schema generic. This wrapper is
    // generic over the same shape, but TypeScript cannot prove the two are equal
    // through the indirection, so the cast lives at this single boundary rather
    // than in every tool definition.
    (async (args: Record<string, unknown>, extra: unknown) => {
      try {
        const ctx = contextFor(extra);
        if (spec.risk !== "read") {
          const summary = spec.summary?.(args as never) ?? spec.name;
          const confirm = (args as { confirm?: boolean }).confirm;
          ctx.guard.check(spec.name, spec.risk, confirm, summary);
        }
        return ok(await spec.handler(args as never, ctx));
      } catch (error) {
        return fail(error);
      }
    }) as never,
  );
}

export function makeContext(
  client: MastodonClient,
  config: Config,
  guard: WriteGuard,
): ToolContext {
  return {
    client,
    config,
    guard,
    account: (hint?: string) => selectAccount(config, hint),
  };
}

/** Clamp a caller-supplied limit into a range Mastodon will accept. */
export function clamp(value: number | undefined, fallback: number, max = 100): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), max);
}

/**
 * Page through a cursor endpoint until `max` items or the pages run out.
 *
 * Mastodon caps a page at 100. Asking for "my last 300 posts" is a normal thing
 * to want, and making the model drive the cursor loop by hand costs a round
 * trip per page and usually gets abandoned after the first one.
 */
export async function paginate<T>(
  fetchPage: (cursor: string | undefined, limit: number) => Promise<{ items: T[]; cursor?: string }>,
  max: number,
  options: { pageSize?: number; stop?: (item: T) => boolean } = {},
): Promise<{ items: T[]; cursor?: string; truncated: boolean }> {
  const pageSize = options.pageSize ?? 100;
  const items: T[] = [];
  let cursor: string | undefined;
  // A hard ceiling so a server that keeps returning a cursor cannot spin here.
  const maxPages = Math.max(1, Math.ceil(max / pageSize) + 2);

  for (let page = 0; page < maxPages && items.length < max; page++) {
    const wanted = Math.min(pageSize, max - items.length);
    const result = await fetchPage(cursor, wanted);
    if (result.items.length === 0) return { items, cursor: result.cursor, truncated: false };

    for (const item of result.items) {
      if (options.stop?.(item)) {
        return { items, cursor: undefined, truncated: false };
      }
      items.push(item);
      if (items.length >= max) break;
    }

    cursor = result.cursor;
    if (!cursor) return { items, cursor: undefined, truncated: false };
  }

  return { items, cursor, truncated: Boolean(cursor) };
}
