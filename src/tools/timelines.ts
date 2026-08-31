/**
 * Timelines.
 *
 * Mastodon has more of them than any other network here, and which one you read
 * changes what you see completely:
 *
 *   home      accounts you follow, plus hashtags you follow
 *   local     everything public on your own instance
 *   public    everything public your instance has federated in, the whole network
 *   hashtag   one tag, optionally restricted to your instance
 *   list      one curated list
 *
 * All of them page through a `Link` header rather than a cursor in the body,
 * which is easy to miss: stop at one response and "the last 200 posts" silently
 * returns 40.
 */

import { z } from "zod";
import { renderStatuses } from "../format/statuses.js";
import { accountArg, clamp, defineTool, type AnyToolSpec } from "./kit.js";

type Any = Record<string, any>;

const sinceArg = {
  since_hours: z
    .number()
    .min(0.1)
    .max(720)
    .optional()
    .describe("Instead of a fixed count, return everything from the last N hours, up to `limit`."),
};

/** Stop-predicate for a time window, applied to a status's own timestamp. */
function olderThan(cutoff: number) {
  return (status: Any) => {
    const created = status?.created_at;
    if (typeof created !== "string") return false;
    const at = new Date(created).getTime();
    return Number.isFinite(at) && at < cutoff;
  };
}

const limitArg = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(400)
    .optional()
    .describe("How many statuses. Pages automatically past the 40-per-request ceiling. Default 40."),
  max_id: z.string().optional().describe("Continue from a previous page: pass the next_max_id from the last result."),
};

function timelineTool(
  name: string,
  title: string,
  description: string,
  path: (args: Any) => string,
  extraSchema: Record<string, z.ZodTypeAny> = {},
  extraQuery: (args: Any) => Record<string, unknown> = () => ({}),
) {
  return defineTool({
    name,
    title,
    description,
    schema: { ...extraSchema, ...limitArg, ...sinceArg, ...accountArg },
    risk: "read",
    handler: async (args: Any, ctx) => {
      const chosen = ctx.account(args.account);
      const max = clamp(args.limit, 40, 400);
      const cutoff = args.since_hours ? Date.now() - args.since_hours * 3_600_000 : undefined;

      const result = await ctx.client.paginate<Any>(
        chosen,
        path(args),
        { query: { ...extraQuery(args), max_id: args.max_id } },
        max,
        cutoff ? olderThan(cutoff) : undefined,
      );

      return renderStatuses(result.items, {
        source: name.replace(/^get_/, "").replace(/_/g, " "),
        nextMaxId: result.nextMaxId,
        note: args.since_hours ? `Last ${args.since_hours}h.` : undefined,
      });
    },
  });
}

const home = timelineTool(
  "get_home_timeline",
  "Read your home timeline",
  "Statuses from the accounts and hashtags you follow, newest first. Pass since_hours to read a time window rather than a fixed count.",
  () => "/api/v1/timelines/home",
);

const local = timelineTool(
  "get_local_timeline",
  "Read your instance's local timeline",
  "Everything public posted by accounts on your own instance. On a small themed instance this is the most useful timeline there is; on mastodon.social it is a firehose.",
  () => "/api/v1/timelines/public",
  {},
  () => ({ local: true }),
);

const federated = timelineTool(
  "get_federated_timeline",
  "Read the federated timeline",
  "Everything public your instance has federated in from the rest of the network. Large and unfiltered: use search or a hashtag timeline if you are looking for something specific.",
  () => "/api/v1/timelines/public",
  {
    remote_only: z.boolean().optional().describe("Exclude your own instance's posts."),
    only_media: z.boolean().optional().describe("Only statuses with attachments."),
  },
  (a) => ({ remote: a.remote_only, only_media: a.only_media }),
);

const hashtag = timelineTool(
  "get_hashtag_timeline",
  "Read a hashtag timeline",
  "Public statuses carrying a hashtag. Hashtags are how discovery works on Mastodon, since there is no algorithmic feed, so this is the main way to find a conversation.",
  (a) => `/api/v1/timelines/tag/${encodeURIComponent(String(a.hashtag).replace(/^#/, ""))}`,
  {
    hashtag: z.string().describe("The tag, with or without the leading #."),
    local_only: z.boolean().optional().describe("Only posts from your own instance."),
    any: z.array(z.string()).optional().describe("Also include statuses carrying any of these other tags."),
    all: z.array(z.string()).optional().describe("Only statuses carrying all of these tags as well."),
    none: z.array(z.string()).optional().describe("Exclude statuses carrying any of these tags."),
  },
  (a) => ({ local: a.local_only, any: a.any, all: a.all, none: a.none }),
);

const listTimeline = timelineTool(
  "get_list_timeline",
  "Read a list's timeline",
  "Statuses from the accounts on one of your lists. Find list ids with get_lists.",
  (a) => `/api/v1/timelines/list/${encodeURIComponent(String(a.list_id))}`,
  { list_id: z.string().describe("The list id, from get_lists.") },
);

const accountStatuses = defineTool({
  name: "get_account_statuses",
  title: "Read an account's posts",
  description:
    "Statuses by one account, newest first. Use exclude_replies when studying how someone writes, so replies do not dominate the sample.",
  schema: {
    acct: z.string().describe("Handle as @user@instance, or a bare local username, or a numeric account id."),
    exclude_replies: z.boolean().optional().describe("Leave out replies. Default false."),
    exclude_reblogs: z.boolean().optional().describe("Leave out boosts. Default false."),
    only_media: z.boolean().optional().describe("Only statuses with attachments."),
    tagged: z.string().optional().describe("Only statuses carrying this hashtag."),
    pinned: z.boolean().optional().describe("Return only the account's pinned statuses."),
    ...limitArg,
    ...sinceArg,
    ...accountArg,
  },
  risk: "read",
  handler: async (args, ctx) => {
    const chosen = ctx.account(args.account);
    const id = await resolveAccountId(ctx, chosen, args.acct);
    const max = clamp(args.limit, 40, 400);
    const cutoff = args.since_hours ? Date.now() - args.since_hours * 3_600_000 : undefined;

    const result = await ctx.client.paginate<Any>(
      chosen,
      `/api/v1/accounts/${id}/statuses`,
      {
        query: {
          exclude_replies: args.exclude_replies,
          exclude_reblogs: args.exclude_reblogs,
          only_media: args.only_media,
          tagged: args.tagged,
          pinned: args.pinned,
          max_id: args.max_id,
        },
      },
      max,
      cutoff ? olderThan(cutoff) : undefined,
    );

    return renderStatuses(result.items, {
      source: `@${String(args.acct).replace(/^@/, "")}`,
      nextMaxId: result.nextMaxId,
      note: args.since_hours ? `Last ${args.since_hours}h.` : undefined,
    });
  },
});

/**
 * Turn a handle into the numeric id every account endpoint needs.
 *
 * `/api/v1/accounts/lookup` resolves a local or already-known remote handle
 * without touching the network. When that misses, a search with `resolve=true`
 * makes the instance go and fetch the remote account, which is the only way to
 * reach someone your instance has never seen. Without the fallback, looking up
 * an account on an obscure server just fails.
 */
export async function resolveAccountId(
  ctx: { client: { call: Function; list: Function } },
  chosen: any,
  acct: string,
): Promise<string> {
  const cleaned = String(acct).trim().replace(/^@/, "");
  if (/^\d+$/.test(cleaned)) return cleaned;

  try {
    const found = (await ctx.client.call(chosen, "/api/v1/accounts/lookup", {
      query: { acct: cleaned },
    })) as { id?: string };
    if (found?.id) return found.id;
  } catch {
    // Not known locally. Fall through to a resolving search.
  }

  const search = (await ctx.client.call(chosen, "/api/v2/search", {
    query: { q: cleaned, type: "accounts", resolve: true, limit: 5 },
  })) as { accounts?: Array<{ id: string; acct: string }> };

  const exact = search.accounts?.find((a) => a.acct.toLowerCase() === cleaned.toLowerCase());
  if (exact) return exact.id;
  if (search.accounts?.[0]) return search.accounts[0].id;

  throw new Error(
    `No account found for "${acct}". Use the full @user@instance form. If they are on a server yours has never federated with, try searching for their profile URL instead.`,
  );
}

export const timelineTools: AnyToolSpec[] = [
  home as AnyToolSpec,
  local as AnyToolSpec,
  federated as AnyToolSpec,
  hashtag as AnyToolSpec,
  listTimeline as AnyToolSpec,
  accountStatuses as AnyToolSpec,
];
