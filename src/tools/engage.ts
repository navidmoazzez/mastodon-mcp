/**
 * Favouriting, boosting, bookmarking, pinning, voting, and undoing all of it.
 *
 * Every action has its inverse. `the-focus-ai`'s server has none of these at
 * all; `VitexSoftware`'s has the pairs but not pin, mute-conversation, vote or
 * translate. An agent that can add to your timeline but not take it back is an
 * agent you cannot leave alone with it.
 */

import { z } from "zod";
import { renderAccounts } from "../format/statuses.js";
import { htmlToMarkdown } from "../content/html.js";
import { accountArg, defineTool, type AnyToolSpec } from "./kit.js";

/** The action/undo pairs, which are all the same shape. */
const PAIRS = [
  ["favourite_status", "unfavourite_status", "favourite", "unfavourite", "Favourite a status.", "Remove your favourite from a status."],
  ["boost_status", "unboost_status", "reblog", "unreblog", "Boost a status to your followers. To add a comment instead, post a status quoting its URL: Mastodon has no native quote post.", "Undo a boost."],
  ["bookmark_status", "unbookmark_status", "bookmark", "unbookmark", "Bookmark a status. Bookmarks are private, unlike favourites, which the author can see.", "Remove a bookmark."],
  ["pin_status", "unpin_status", "pin", "unpin", "Pin one of your own statuses to the top of your profile.", "Unpin a status from your profile."],
  ["mute_conversation", "unmute_conversation", "mute", "unmute", "Stop being notified about replies to this thread, without leaving it. The tool nobody reaches for until a post goes unexpectedly wide.", "Start being notified about this thread again."],
] as const;

const pairTools = PAIRS.flatMap(([onName, offName, onVerb, offVerb, onDesc, offDesc]) => [
  defineTool({
    name: onName,
    title: onDesc.split(".")[0] ?? onName,
    description: onDesc,
    schema: { id: z.string().describe("The status id."), ...accountArg },
    risk: "write",
    idempotent: true,
    summary: (a) => `${onVerb} ${a.id}`,
    handler: async ({ id, account }, ctx) => {
      const chosen = ctx.account(account);
      const r = await ctx.client.call<Record<string, any>>(chosen, `/api/v1/statuses/${id}/${onVerb}`, {
        method: "POST",
      });
      return { id: r.id ?? id, url: r.url, action: onVerb };
    },
  }),
  defineTool({
    name: offName,
    title: offDesc.split(".")[0] ?? offName,
    description: offDesc,
    schema: { id: z.string().describe("The status id."), ...accountArg },
    risk: "write",
    idempotent: true,
    summary: (a) => `${offVerb} ${a.id}`,
    handler: async ({ id, account }, ctx) => {
      const chosen = ctx.account(account);
      const r = await ctx.client.call<Record<string, any>>(chosen, `/api/v1/statuses/${id}/${offVerb}`, {
        method: "POST",
      });
      return { id: r.id ?? id, url: r.url, action: offVerb };
    },
  }),
]);

const votePoll = defineTool({
  name: "vote_poll",
  title: "Vote in a poll",
  description:
    "Vote in a poll by option index, counting from zero. A vote cannot be changed or taken back, so it needs confirm: true.",
  schema: {
    poll_id: z.string().describe("The poll id, from the <poll> element on the status."),
    choices: z
      .array(z.number().int().min(0))
      .min(1)
      .describe("Option indexes, counting from zero. More than one only if the poll allows it."),
    ...accountArg,
    confirm: z.boolean().optional().describe("Must be true. A vote is public to the instance and cannot be undone."),
  },
  risk: "destructive",
  public: true,
  summary: (a) => `vote ${a.choices.join(",")} in poll ${a.poll_id}`,
  handler: async ({ poll_id, choices, account }, ctx) => {
    const chosen = ctx.account(account);
    const poll = await ctx.client.call<Record<string, any>>(chosen, `/api/v1/polls/${poll_id}/votes`, {
      method: "POST",
      form: { choices },
    });
    return {
      poll_id,
      voted: poll.voted,
      votes: poll.votes_count,
      options: (poll.options ?? []).map((o: Record<string, any>, i: number) => ({
        index: i,
        title: o.title,
        votes: o.votes_count,
      })),
    };
  },
});

const translateStatus = defineTool({
  name: "translate_status",
  title: "Translate a status",
  description:
    "Translate a status into your language using the instance's translation backend. Only works on instances that have configured one, which is a minority, so a 404 here means the feature is off rather than that the status is missing.",
  schema: {
    id: z.string(),
    lang: z.string().optional().describe("Target ISO 639 code. Defaults to the account's own language."),
    ...accountArg,
  },
  risk: "read",
  handler: async ({ id, lang, account }, ctx) => {
    const chosen = ctx.account(account);
    const t = await ctx.client.call<Record<string, any>>(chosen, `/api/v1/statuses/${id}/translate`, {
      method: "POST",
      form: { lang },
    });
    return {
      id,
      detected_source_language: t.detected_source_language,
      provider: t.provider,
      content: htmlToMarkdown(t.content ?? ""),
      spoiler_text: t.spoiler_text || undefined,
    };
  },
});

const favouritedBy = defineTool({
  name: "get_favourited_by",
  title: "See who favourited a status",
  description:
    "The accounts that favourited a status. Federation means this is only who your instance knows about, not necessarily everyone.",
  schema: {
    id: z.string(),
    limit: z.number().int().min(1).max(200).optional().describe("How many. Default 40."),
    ...accountArg,
  },
  risk: "read",
  handler: async ({ id, limit, account }, ctx) => {
    const chosen = ctx.account(account);
    const result = await ctx.client.paginate<Record<string, any>>(
      chosen,
      `/api/v1/statuses/${id}/favourited_by`,
      {},
      Math.min(limit ?? 40, 200),
    );
    return renderAccounts(result.items, { source: `favourited ${id}`, nextMaxId: result.nextMaxId });
  },
});

const boostedBy = defineTool({
  name: "get_boosted_by",
  title: "See who boosted a status",
  description: "The accounts that boosted a status, as far as your instance knows.",
  schema: {
    id: z.string(),
    limit: z.number().int().min(1).max(200).optional().describe("How many. Default 40."),
    ...accountArg,
  },
  risk: "read",
  handler: async ({ id, limit, account }, ctx) => {
    const chosen = ctx.account(account);
    const result = await ctx.client.paginate<Record<string, any>>(
      chosen,
      `/api/v1/statuses/${id}/reblogged_by`,
      {},
      Math.min(limit ?? 40, 200),
    );
    return renderAccounts(result.items, { source: `boosted ${id}`, nextMaxId: result.nextMaxId });
  },
});

const reportContent = defineTool({
  name: "report",
  title: "Report an account or status",
  description:
    "Report an account, optionally with specific statuses, to your instance's moderators. Optionally forwards to the account's home instance. This reaches human moderators, so it needs confirm: true.",
  schema: {
    account_id: z.string().describe("The account being reported."),
    status_ids: z.array(z.string()).optional().describe("Specific statuses as evidence."),
    comment: z.string().max(1000).optional().describe("What is wrong, for the moderators."),
    category: z
      .enum(["spam", "legal", "violation", "other"])
      .optional()
      .describe("'violation' means it breaks a specific server rule; pass rule_ids with it."),
    rule_ids: z.array(z.string()).optional().describe("Rule ids from get_instance_info."),
    forward: z
      .boolean()
      .optional()
      .describe("Also send the report to the account's home instance. Default false."),
    ...accountArg,
    confirm: z.boolean().optional().describe("Must be true. This reaches human moderators."),
  },
  risk: "destructive",
  summary: (a) => `report account ${a.account_id}`,
  handler: async (args, ctx) => {
    const chosen = ctx.account(args.account);
    const r = await ctx.client.call<Record<string, any>>(chosen, "/api/v1/reports", {
      method: "POST",
      form: {
        account_id: args.account_id,
        status_ids: args.status_ids,
        comment: args.comment,
        category: args.category,
        rule_ids: args.rule_ids,
        forward: args.forward ?? false,
      },
    });
    return { report_id: r.id, forwarded: r.forwarded, category: r.category };
  },
});

export const engageTools: AnyToolSpec[] = [
  ...(pairTools as unknown as AnyToolSpec[]),
  votePoll as AnyToolSpec,
  translateStatus as AnyToolSpec,
  favouritedBy as AnyToolSpec,
  boostedBy as AnyToolSpec,
  reportContent as AnyToolSpec,
];
