/**
 * Finding things: search, trends, hashtags, lists, and conversations.
 *
 * Mastodon has no algorithmic feed, so discovery is done by hand: hashtags,
 * trends, the profile directory, and curated lists. That makes these tools more
 * load-bearing here than on any other network, and it is why following a
 * *hashtag* is a first-class feature.
 *
 * One thing worth knowing about search: Mastodon does not full-text search
 * public statuses by default. Most instances only index your own posts and ones
 * you have interacted with, unless the admin has enabled full-text search. A
 * thin result set is usually the instance's policy, not a bad query.
 */

import { z } from "zod";
import { renderAccounts, renderStatuses } from "../format/statuses.js";
import { escapeXml } from "../content/text.js";
import { accountArg, clamp, defineTool, type AnyToolSpec } from "./kit.js";

type Any = Record<string, any>;

const search = defineTool({
  name: "search",
  title: "Search",
  description:
    "Search for accounts, statuses or hashtags. Pasting a URL here with resolve on is also how you pull in a remote post or profile your instance has never seen. Note that most instances do not full-text search public statuses: a thin result set is usually the instance's policy rather than a bad query.",
  schema: {
    q: z.string().describe("Words, a hashtag, a handle, or the full URL of a post or profile."),
    type: z
      .enum(["accounts", "statuses", "hashtags"])
      .optional()
      .describe("Restrict the search. Omit for all three."),
    resolve: z
      .boolean()
      .optional()
      .describe("Fetch a remote account or status your instance has not seen. Default true, which is what you want when passing a URL."),
    following_only: z.boolean().optional().describe("Only accounts you already follow."),
    account_acct: z.string().optional().describe("Only statuses by this account."),
    limit: z.number().int().min(1).max(40).optional().describe("How many of each type. Default 20."),
    ...accountArg,
  },
  risk: "read",
  handler: async (args, ctx) => {
    const chosen = ctx.account(args.account);
    let accountId: string | undefined;
    if (args.account_acct) {
      const { resolveAccountId } = await import("./timelines.js");
      accountId = await resolveAccountId(ctx as never, chosen, args.account_acct);
    }

    const data = await ctx.client.call<Any>(chosen, "/api/v2/search", {
      query: {
        q: args.q,
        type: args.type,
        resolve: args.resolve ?? true,
        following: args.following_only,
        account_id: accountId,
        limit: clamp(args.limit, 20, 40),
      },
    });

    const parts: string[] = [];
    if (data.accounts?.length) parts.push(renderAccounts(data.accounts, { source: `search: ${args.q}` }));
    if (data.statuses?.length) parts.push(renderStatuses(data.statuses, { source: `search: ${args.q}` }));
    if (data.hashtags?.length) {
      let out = `<hashtags count="${data.hashtags.length}">\n`;
      for (const tag of data.hashtags) {
        const recent = (tag.history ?? []).slice(0, 2);
        const uses = recent.reduce((sum: number, h: Any) => sum + Number(h.uses ?? 0), 0);
        out += `  <hashtag name="${escapeXml(tag.name)}" url="${escapeXml(tag.url)}" recent_uses="${uses}"`;
        if (tag.following !== undefined) out += ` you_follow="${Boolean(tag.following)}"`;
        out += ` />\n`;
      }
      out += `</hashtags>\n`;
      parts.push(out);
    }

    return parts.length
      ? parts.join("\n")
      : `<search q="${escapeXml(args.q)}" results="0" note="Most instances do not full-text index public statuses. Try a hashtag timeline, or paste the post's URL with resolve on." />\n`;
  },
});

const trends = defineTool({
  name: "get_trends",
  title: "See what is trending",
  description:
    "What is trending on this instance right now: hashtags, statuses, or links. Trends are per instance, not network-wide, so a small themed server shows something completely different from mastodon.social.",
  schema: {
    kind: z.enum(["tags", "statuses", "links"]).optional().describe("Which kind. Default tags."),
    limit: z.number().int().min(1).max(40).optional().describe("How many. Default 10."),
    ...accountArg,
  },
  risk: "read",
  handler: async ({ kind, limit, account }, ctx) => {
    const chosen = ctx.account(account);
    const size = clamp(limit, 10, 40);
    const which = kind ?? "tags";

    if (which === "statuses") {
      const rows = await ctx.client.call<Any[]>(chosen, "/api/v1/trends/statuses", {
        query: { limit: size },
      });
      return renderStatuses(rows ?? [], { source: "trending statuses" });
    }

    if (which === "links") {
      const rows = await ctx.client.call<Any[]>(chosen, "/api/v1/trends/links", { query: { limit: size } });
      let out = `<trending_links count="${(rows ?? []).length}">\n`;
      for (const link of rows ?? []) {
        out += `  <link url="${escapeXml(link.url)}" title="${escapeXml(link.title)}"`;
        out += ` publisher="${escapeXml(link.provider_name ?? "")}"`;
        const uses = (link.history ?? []).slice(0, 2).reduce((s: number, h: Any) => s + Number(h.uses ?? 0), 0);
        out += ` recent_shares="${uses}" />\n`;
      }
      out += `</trending_links>\n`;
      return out;
    }

    const rows = await ctx.client.call<Any[]>(chosen, "/api/v1/trends/tags", { query: { limit: size } });
    let out = `<trending_tags count="${(rows ?? []).length}">\n`;
    for (const tag of rows ?? []) {
      const days = tag.history ?? [];
      const uses = days.slice(0, 2).reduce((s: number, h: Any) => s + Number(h.uses ?? 0), 0);
      const people = days.slice(0, 2).reduce((s: number, h: Any) => s + Number(h.accounts ?? 0), 0);
      out += `  <tag name="${escapeXml(tag.name)}" url="${escapeXml(tag.url)}" recent_uses="${uses}" recent_accounts="${people}" />\n`;
    }
    out += `</trending_tags>\n`;
    return out;
  },
});

const followedTags = defineTool({
  name: "get_followed_hashtags",
  title: "List hashtags you follow",
  description:
    "Hashtags you follow. Following a hashtag puts every public post carrying it into your home timeline, which is how you build a feed on a network with no algorithm. Neither existing Mastodon MCP server exposes this.",
  schema: {
    limit: z.number().int().min(1).max(200).optional().describe("How many. Default 100."),
    ...accountArg,
  },
  risk: "read",
  handler: async ({ limit, account }, ctx) => {
    const chosen = ctx.account(account);
    const result = await ctx.client.paginate<Any>(
      chosen,
      "/api/v1/followed_tags",
      {},
      clamp(limit, 100, 200),
    );
    let out = `<followed_hashtags count="${result.items.length}">\n`;
    for (const tag of result.items) {
      out += `  <tag name="${escapeXml(tag.name)}" url="${escapeXml(tag.url)}" />\n`;
    }
    out += `</followed_hashtags>\n`;
    return out;
  },
});

const followTag = defineTool({
  name: "follow_hashtag",
  title: "Follow a hashtag",
  description:
    "Follow a hashtag, so every public post carrying it appears in your home timeline. The main way to build a feed on Mastodon.",
  schema: { hashtag: z.string().describe("With or without the leading #."), ...accountArg },
  risk: "write",
  idempotent: true,
  summary: (a) => `follow #${String(a.hashtag).replace(/^#/, "")}`,
  handler: async ({ hashtag, account }, ctx) => {
    const chosen = ctx.account(account);
    const name = String(hashtag).replace(/^#/, "");
    const r = await ctx.client.call<Any>(chosen, `/api/v1/tags/${encodeURIComponent(name)}/follow`, {
      method: "POST",
    });
    return { hashtag: r.name ?? name, following: Boolean(r.following) };
  },
});

const unfollowTag = defineTool({
  name: "unfollow_hashtag",
  title: "Unfollow a hashtag",
  description: "Stop a hashtag's posts appearing in your home timeline.",
  schema: { hashtag: z.string(), ...accountArg },
  risk: "write",
  idempotent: true,
  summary: (a) => `unfollow #${String(a.hashtag).replace(/^#/, "")}`,
  handler: async ({ hashtag, account }, ctx) => {
    const chosen = ctx.account(account);
    const name = String(hashtag).replace(/^#/, "");
    const r = await ctx.client.call<Any>(chosen, `/api/v1/tags/${encodeURIComponent(name)}/unfollow`, {
      method: "POST",
    });
    return { hashtag: r.name ?? name, following: Boolean(r.following) };
  },
});

const directory = defineTool({
  name: "browse_directory",
  title: "Browse the profile directory",
  description:
    "Accounts that have opted into being discoverable, newest or most recently active first. Scoped to your own instance unless you ask for the wider network. A way to find people on a network with no recommendation engine.",
  schema: {
    order: z.enum(["active", "new"]).optional().describe("'active' means recently posted. Default active."),
    local_only: z.boolean().optional().describe("Only accounts on your own instance. Default true."),
    limit: z.number().int().min(1).max(80).optional().describe("How many. Default 40."),
    ...accountArg,
  },
  risk: "read",
  handler: async ({ order, local_only, limit, account }, ctx) => {
    const chosen = ctx.account(account);
    const rows = await ctx.client.call<Any[]>(chosen, "/api/v1/directory", {
      query: { order: order ?? "active", local: local_only ?? true, limit: clamp(limit, 40, 80) },
    });
    return renderAccounts(rows ?? [], { source: `directory (${order ?? "active"})` });
  },
});

const suggestions = defineTool({
  name: "get_suggested_follows",
  title: "Get follow suggestions",
  description: "Accounts the instance suggests you follow, with the reason for each suggestion.",
  schema: {
    limit: z.number().int().min(1).max(80).optional().describe("How many. Default 40."),
    ...accountArg,
  },
  risk: "read",
  handler: async ({ limit, account }, ctx) => {
    const chosen = ctx.account(account);
    const rows = await ctx.client.call<Any[]>(chosen, "/api/v2/suggestions", {
      query: { limit: clamp(limit, 40, 80) },
    });
    return renderAccounts(
      (rows ?? []).map((r) => r.account ?? r),
      { source: "suggested" },
    );
  },
});

const getConversations = defineTool({
  name: "get_conversations",
  title: "Read direct messages",
  description:
    "Direct conversations, newest first, each with its participants and last message. Mastodon direct messages are statuses with visibility 'direct', not a separate inbox, so anyone mentioned in one can see it. Neither existing Mastodon MCP server exposes conversations at all.",
  schema: {
    limit: z.number().int().min(1).max(80).optional().describe("How many. Default 20."),
    ...accountArg,
  },
  risk: "read",
  handler: async ({ limit, account }, ctx) => {
    const chosen = ctx.account(account);
    const result = await ctx.client.paginate<Any>(
      chosen,
      "/api/v1/conversations",
      {},
      clamp(limit, 20, 80),
    );
    const { renderStatus } = await import("../format/statuses.js");
    let out = `<conversations count="${result.items.length}"`;
    if (result.nextMaxId) out += ` next_max_id="${escapeXml(result.nextMaxId)}"`;
    out += ">\n";
    for (const c of result.items) {
      out += `  <conversation id="${escapeXml(c.id)}" unread="${Boolean(c.unread)}"`;
      out += ` with="${escapeXml((c.accounts ?? []).map((a: Any) => a.acct).join(", "))}">\n`;
      if (c.last_status) out += renderStatus(c.last_status, {}, 2);
      out += `  </conversation>\n`;
    }
    out += `</conversations>\n`;
    return out;
  },
});

export const discoverTools: AnyToolSpec[] = [
  search as AnyToolSpec,
  trends as AnyToolSpec,
  followedTags as AnyToolSpec,
  followTag as AnyToolSpec,
  unfollowTag as AnyToolSpec,
  directory as AnyToolSpec,
  suggestions as AnyToolSpec,
  getConversations as AnyToolSpec,
];
