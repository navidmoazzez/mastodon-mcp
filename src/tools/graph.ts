/**
 * Profiles, the social graph, and moderation.
 *
 * `get_account` returns the relationship alongside the profile in one call,
 * because the question before any graph action is always "do I already follow
 * them, and have they blocked me", and that is a second endpoint both reference
 * servers make you call separately.
 */

import { z } from "zod";
import { renderAccount, renderAccounts } from "../format/statuses.js";
import { resolveAccountId } from "./timelines.js";
import { accountArg, clamp, confirmArg, defineTool, type AnyToolSpec } from "./kit.js";

type Any = Record<string, any>;

const pageArgs = {
  limit: z.number().int().min(1).max(400).optional().describe("How many. Pages automatically. Default 40."),
  max_id: z.string().optional().describe("Continue from a previous page."),
};

const getAccount = defineTool({
  name: "get_account",
  title: "Read a profile",
  description:
    "Full profile for any account: bio, counts, the metadata fields with their verification state, and whether you follow each other. Accepts @user@instance, a bare local username, or a numeric id. Resolves accounts your instance has never seen before.",
  schema: { acct: z.string(), ...accountArg },
  risk: "read",
  handler: async ({ acct, account }, ctx) => {
    const chosen = ctx.account(account);
    const id = await resolveAccountId(ctx as never, chosen, acct);
    const [profile, relationships] = await Promise.all([
      ctx.client.call<Any>(chosen, `/api/v1/accounts/${id}`),
      ctx.client
        .call<Any[]>(chosen, "/api/v1/accounts/relationships", { query: { id: [id] } })
        .catch(() => [] as Any[]),
    ]);
    return renderAccount(profile, relationships?.[0]);
  },
});

const getFollowers = defineTool({
  name: "get_followers",
  title: "List followers",
  description: "Accounts that follow a given account. Pages automatically past the 40-per-request ceiling.",
  schema: { acct: z.string(), ...pageArgs, ...accountArg },
  risk: "read",
  handler: async ({ acct, limit, max_id, account }, ctx) => {
    const chosen = ctx.account(account);
    const id = await resolveAccountId(ctx as never, chosen, acct);
    const result = await ctx.client.paginate<Any>(
      chosen,
      `/api/v1/accounts/${id}/followers`,
      { query: { max_id } },
      clamp(limit, 40, 400),
    );
    return renderAccounts(result.items, { source: `followers of @${acct}`, nextMaxId: result.nextMaxId });
  },
});

const getFollowing = defineTool({
  name: "get_following",
  title: "List who an account follows",
  description: "Accounts a given account follows. Pages automatically.",
  schema: { acct: z.string(), ...pageArgs, ...accountArg },
  risk: "read",
  handler: async ({ acct, limit, max_id, account }, ctx) => {
    const chosen = ctx.account(account);
    const id = await resolveAccountId(ctx as never, chosen, acct);
    const result = await ctx.client.paginate<Any>(
      chosen,
      `/api/v1/accounts/${id}/following`,
      { query: { max_id } },
      clamp(limit, 40, 400),
    );
    return renderAccounts(result.items, { source: `@${acct} follows`, nextMaxId: result.nextMaxId });
  },
});

const getRelationships = defineTool({
  name: "get_relationships",
  title: "Check follow relationships",
  description:
    "For each account named, whether you follow them, whether they follow you, and whether either of you has muted or blocked the other. One call for a whole list: use this before a bulk follow or unfollow rather than reading each profile.",
  schema: { accts: z.array(z.string()).min(1).max(40), ...accountArg },
  risk: "read",
  handler: async ({ accts, account }, ctx) => {
    const chosen = ctx.account(account);
    const ids = await Promise.all(accts.map((a) => resolveAccountId(ctx as never, chosen, a)));
    const rows = await ctx.client.call<Any[]>(chosen, "/api/v1/accounts/relationships", {
      query: { id: ids },
    });
    return {
      count: (rows ?? []).length,
      relationships: (rows ?? []).map((r, index) => ({
        acct: accts[index],
        id: r.id,
        following: Boolean(r.following),
        followed_by: Boolean(r.followed_by),
        requested: Boolean(r.requested),
        muting: Boolean(r.muting),
        blocking: Boolean(r.blocking),
        blocked_by: Boolean(r.blocked_by),
        notifying: Boolean(r.notifying),
      })),
    };
  },
});

/** follow/unfollow, mute/unmute, block/unblock: same shape, so built once. */
const GRAPH_PAIRS = [
  ["follow_account", "unfollow_account", "follow", "unfollow", "Follow an account. On a locked account this sends a follow request instead.", "Stop following an account."],
  ["mute_account", "unmute_account", "mute", "unmute", "Hide an account from your timelines without them knowing. Private and reversible; unlike a block, they can still see and reply to you.", "Stop hiding an account."],
] as const;

const graphPairTools = GRAPH_PAIRS.flatMap(([onName, offName, onVerb, offVerb, onDesc, offDesc]) => [
  defineTool({
    name: onName,
    title: onDesc.split(".")[0] ?? onName,
    description: onDesc,
    schema: {
      acct: z.string().describe("@user@instance, a bare local username, or a numeric id."),
      ...(onVerb === "follow"
        ? {
            notify: z.boolean().optional().describe("Get a notification for every post they make."),
            reblogs: z.boolean().optional().describe("Show their boosts in your timeline. Default true."),
          }
        : {
            duration: z
              .number()
              .int()
              .min(0)
              .optional()
              .describe("Seconds to mute for. 0 or omitted means indefinitely."),
          }),
      ...accountArg,
    },
    risk: "write",
    idempotent: true,
    summary: (a: Any) => `${onVerb} ${a.acct}`,
    handler: async (args: Any, ctx) => {
      const chosen = ctx.account(args.account);
      const id = await resolveAccountId(ctx as never, chosen, args.acct);
      const form =
        onVerb === "follow"
          ? { notify: args.notify, reblogs: args.reblogs }
          : { duration: args.duration };
      const r = await ctx.client.call<Any>(chosen, `/api/v1/accounts/${id}/${onVerb}`, {
        method: "POST",
        form,
      });
      return {
        acct: args.acct,
        id,
        following: Boolean(r.following),
        requested: Boolean(r.requested),
        muting: Boolean(r.muting),
        ...(r.requested ? { note: "That account approves followers manually, so this is a pending request." } : {}),
      };
    },
  }),
  defineTool({
    name: offName,
    title: offDesc.split(".")[0] ?? offName,
    description: offDesc,
    schema: { acct: z.string(), ...accountArg },
    risk: "write",
    idempotent: true,
    summary: (a: Any) => `${offVerb} ${a.acct}`,
    handler: async (args: Any, ctx) => {
      const chosen = ctx.account(args.account);
      const id = await resolveAccountId(ctx as never, chosen, args.acct);
      const r = await ctx.client.call<Any>(chosen, `/api/v1/accounts/${id}/${offVerb}`, { method: "POST" });
      return { acct: args.acct, id, following: Boolean(r.following), muting: Boolean(r.muting) };
    },
  }),
]);

const blockAccount = defineTool({
  name: "block_account",
  title: "Block an account",
  description:
    "Block an account. This is visible to them, removes any follow in either direction, and hides your posts from them. Reversible, but the follows do not come back. Needs confirm: true.",
  schema: { acct: z.string(), ...accountArg, ...confirmArg },
  risk: "destructive",
  public: true,
  summary: (a) => `block ${a.acct}`,
  handler: async ({ acct, account }, ctx) => {
    const chosen = ctx.account(account);
    const id = await resolveAccountId(ctx as never, chosen, acct);
    const r = await ctx.client.call<Any>(chosen, `/api/v1/accounts/${id}/block`, { method: "POST" });
    return { acct, id, blocking: Boolean(r.blocking) };
  },
});

const unblockAccount = defineTool({
  name: "unblock_account",
  title: "Unblock an account",
  description: "Remove a block. Any follows the block severed do not come back; both sides have to follow again.",
  schema: { acct: z.string(), ...accountArg },
  risk: "write",
  idempotent: true,
  summary: (a) => `unblock ${a.acct}`,
  handler: async ({ acct, account }, ctx) => {
    const chosen = ctx.account(account);
    const id = await resolveAccountId(ctx as never, chosen, acct);
    const r = await ctx.client.call<Any>(chosen, `/api/v1/accounts/${id}/unblock`, { method: "POST" });
    return { acct, id, blocking: Boolean(r.blocking) };
  },
});

const blockDomain = defineTool({
  name: "block_domain",
  title: "Block a whole instance",
  description:
    "Hide every account on an entire instance and remove their followers. This is the blunt instrument for a server that is a persistent problem rather than one account. Needs confirm: true.",
  schema: {
    domain: z.string().describe("Bare hostname, e.g. spam.example."),
    ...accountArg,
    ...confirmArg,
  },
  risk: "destructive",
  summary: (a) => `block the whole domain ${a.domain}`,
  handler: async ({ domain, account }, ctx) => {
    const chosen = ctx.account(account);
    await ctx.client.call(chosen, "/api/v1/domain_blocks", { method: "POST", form: { domain } });
    return { blocked_domain: domain };
  },
});

const unblockDomain = defineTool({
  name: "unblock_domain",
  title: "Unblock an instance",
  description: "Lift a domain block. Followers removed by the block are not restored.",
  schema: { domain: z.string(), ...accountArg },
  risk: "write",
  idempotent: true,
  summary: (a) => `unblock the domain ${a.domain}`,
  handler: async ({ domain, account }, ctx) => {
    const chosen = ctx.account(account);
    await ctx.client.call(chosen, "/api/v1/domain_blocks", { method: "DELETE", form: { domain } });
    return { unblocked_domain: domain };
  },
});

/** The three simple "what have I hidden" listings. */
const LISTINGS = [
  ["get_mutes", "/api/v1/mutes", "Accounts you have muted."],
  ["get_blocks", "/api/v1/blocks", "Accounts you have blocked."],
  ["get_endorsements", "/api/v1/endorsements", "Accounts you feature on your own profile."],
] as const;

const listingTools = LISTINGS.map(([name, path, description]) =>
  defineTool({
    name,
    title: description.replace(/\.$/, ""),
    description,
    schema: { ...pageArgs, ...accountArg },
    risk: "read",
    handler: async ({ limit, max_id, account }, ctx) => {
      const chosen = ctx.account(account);
      const result = await ctx.client.paginate<Any>(
        chosen,
        path,
        { query: { max_id } },
        clamp(limit, 40, 400),
      );
      return renderAccounts(result.items, { source: name.replace("get_", ""), nextMaxId: result.nextMaxId });
    },
  }),
);

const getBlockedDomains = defineTool({
  name: "get_blocked_domains",
  title: "List instances you have blocked",
  description: "Whole instances you have blocked.",
  schema: { ...pageArgs, ...accountArg },
  risk: "read",
  handler: async ({ limit, max_id, account }, ctx) => {
    const chosen = ctx.account(account);
    const result = await ctx.client.paginate<string>(
      chosen,
      "/api/v1/domain_blocks",
      { query: { max_id } },
      clamp(limit, 100, 400),
    );
    return { count: result.items.length, domains: result.items };
  },
});

const getFollowRequests = defineTool({
  name: "get_follow_requests",
  title: "List pending follow requests",
  description: "Accounts waiting for you to approve their follow. Only meaningful on a locked account.",
  schema: { ...pageArgs, ...accountArg },
  risk: "read",
  handler: async ({ limit, max_id, account }, ctx) => {
    const chosen = ctx.account(account);
    const result = await ctx.client.paginate<Any>(
      chosen,
      "/api/v1/follow_requests",
      { query: { max_id } },
      clamp(limit, 40, 400),
    );
    return renderAccounts(result.items, { source: "follow requests", nextMaxId: result.nextMaxId });
  },
});

const answerFollowRequest = defineTool({
  name: "answer_follow_request",
  title: "Approve or reject a follow request",
  description: "Approve or reject a pending follow request. Rejecting is silent; they are not told.",
  schema: {
    acct: z.string().describe("The requesting account."),
    decision: z.enum(["authorize", "reject"]),
    ...accountArg,
  },
  risk: "write",
  summary: (a) => `${a.decision} the follow request from ${a.acct}`,
  handler: async ({ acct, decision, account }, ctx) => {
    const chosen = ctx.account(account);
    const id = await resolveAccountId(ctx as never, chosen, acct);
    const r = await ctx.client.call<Any>(chosen, `/api/v1/follow_requests/${id}/${decision}`, {
      method: "POST",
    });
    return { acct, id, decision, followed_by: Boolean(r.followed_by) };
  },
});

export const graphTools: AnyToolSpec[] = [
  getAccount as AnyToolSpec,
  getFollowers as AnyToolSpec,
  getFollowing as AnyToolSpec,
  getRelationships as AnyToolSpec,
  ...(graphPairTools as unknown as AnyToolSpec[]),
  blockAccount as AnyToolSpec,
  unblockAccount as AnyToolSpec,
  blockDomain as AnyToolSpec,
  unblockDomain as AnyToolSpec,
  ...(listingTools as unknown as AnyToolSpec[]),
  getBlockedDomains as AnyToolSpec,
  getFollowRequests as AnyToolSpec,
  answerFollowRequest as AnyToolSpec,
];
