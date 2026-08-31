/**
 * Notifications and lists.
 *
 * `mark_read` uses Mastodon's `markers` API, which stores a read position per
 * timeline and syncs it to every client you use. Without it, an agent asked to
 * "deal with my mentions" reads the same twenty every time it runs, and marking
 * them read in the web app does nothing here.
 */

import { z } from "zod";
import { renderAccounts, renderNotifications } from "../format/statuses.js";
import { resolveAccountId } from "./timelines.js";
import { accountArg, clamp, confirmArg, defineTool, type AnyToolSpec } from "./kit.js";

type Any = Record<string, any>;

const TYPES = [
  "mention",
  "status",
  "reblog",
  "follow",
  "follow_request",
  "favourite",
  "poll",
  "update",
  "admin.sign_up",
  "admin.report",
] as const;

const getNotifications = defineTool({
  name: "get_notifications",
  title: "Read notifications",
  description:
    "Mentions, boosts, favourites, follows, poll results and edits to posts you interacted with. Filter by type to get only the ones that need an answer: 'mention' is the one a person actually has to deal with.",
  schema: {
    types: z.array(z.enum(TYPES)).optional().describe("Only these kinds. Omit for everything."),
    exclude_types: z.array(z.enum(TYPES)).optional().describe("Everything except these kinds."),
    limit: z.number().int().min(1).max(200).optional().describe("How many. Pages automatically. Default 40."),
    max_id: z.string().optional().describe("Continue from a previous page."),
    since_id: z
      .string()
      .optional()
      .describe("Only notifications newer than this id. Pass the marker from get_read_position to get just the new ones."),
    ...accountArg,
  },
  risk: "read",
  handler: async ({ types, exclude_types, limit, max_id, since_id, account }, ctx) => {
    const chosen = ctx.account(account);
    const result = await ctx.client.paginate<Any>(
      chosen,
      "/api/v1/notifications",
      { query: { types, exclude_types, max_id, since_id } },
      clamp(limit, 40, 200),
    );
    return renderNotifications(result.items, { nextMaxId: result.nextMaxId });
  },
});

const getReadPosition = defineTool({
  name: "get_read_position",
  title: "Check how far you have read",
  description:
    "The last notification and home-timeline entry you marked read, shared across every client on this account. Pass the returned id as since_id to fetch only what is new.",
  schema: { ...accountArg },
  risk: "read",
  handler: async ({ account }, ctx) => {
    const chosen = ctx.account(account);
    const markers = await ctx.client.call<Any>(chosen, "/api/v1/markers", {
      query: { timeline: ["home", "notifications"] },
    });
    return {
      notifications_last_read_id: markers?.notifications?.last_read_id ?? null,
      home_last_read_id: markers?.home?.last_read_id ?? null,
      updated_at: markers?.notifications?.updated_at ?? null,
    };
  },
});

const markRead = defineTool({
  name: "mark_read",
  title: "Mark notifications read",
  description:
    "Record how far you have read, so the next get_notifications with since_id returns only what is new. Syncs to the web app and every other client. Affects only your own view.",
  schema: {
    notifications_id: z.string().optional().describe("Last notification id read. Take it from get_notifications."),
    home_id: z.string().optional().describe("Last home-timeline status id read."),
    ...accountArg,
  },
  risk: "write",
  idempotent: true,
  summary: () => "mark notifications read",
  handler: async ({ notifications_id, home_id, account }, ctx) => {
    const chosen = ctx.account(account);
    const form: Record<string, unknown> = {};
    if (notifications_id) form["notifications[last_read_id]"] = notifications_id;
    if (home_id) form["home[last_read_id]"] = home_id;
    if (!Object.keys(form).length) {
      throw new Error("Pass notifications_id, home_id, or both.");
    }
    const markers = await ctx.client.call<Any>(chosen, "/api/v1/markers", { method: "POST", form });
    return {
      notifications_last_read_id: markers?.notifications?.last_read_id ?? null,
      home_last_read_id: markers?.home?.last_read_id ?? null,
    };
  },
});

const dismissNotification = defineTool({
  name: "dismiss_notification",
  title: "Dismiss one notification",
  description: "Remove a single notification from the list. This is not undoable.",
  schema: { id: z.string(), ...accountArg },
  risk: "write",
  summary: (a) => `dismiss notification ${a.id}`,
  handler: async ({ id, account }, ctx) => {
    const chosen = ctx.account(account);
    await ctx.client.call(chosen, `/api/v1/notifications/${id}/dismiss`, { method: "POST" });
    return { dismissed: id };
  },
});

const clearNotifications = defineTool({
  name: "clear_notifications",
  title: "Clear every notification",
  description:
    "Delete all notifications permanently. This is not the same as marking them read, and there is no undo. Needs confirm: true.",
  schema: { ...accountArg, ...confirmArg },
  risk: "destructive",
  summary: () => "clear every notification permanently",
  handler: async ({ account }, ctx) => {
    const chosen = ctx.account(account);
    await ctx.client.call(chosen, "/api/v1/notifications/clear", { method: "POST" });
    return { cleared: true };
  },
});

const getLists = defineTool({
  name: "get_lists",
  title: "List your lists",
  description:
    "Your curated lists. Pass a list id to get_list_timeline to read it, which is the closest thing Mastodon has to a custom feed.",
  schema: { ...accountArg },
  risk: "read",
  handler: async ({ account }, ctx) => {
    const chosen = ctx.account(account);
    const rows = await ctx.client.call<Any[]>(chosen, "/api/v1/lists");
    return {
      count: (rows ?? []).length,
      lists: (rows ?? []).map((l) => ({
        id: l.id,
        title: l.title,
        replies_policy: l.replies_policy,
        exclusive: Boolean(l.exclusive),
      })),
    };
  },
});

const createList = defineTool({
  name: "create_list",
  title: "Create a list",
  description: "Create a curated list. Add accounts to it with add_to_list.",
  schema: {
    title: z.string().describe("The list name."),
    replies_policy: z
      .enum(["followed", "list", "none"])
      .optional()
      .describe("Whose replies appear in the list timeline. Default 'list', meaning only replies to other list members."),
    exclusive: z
      .boolean()
      .optional()
      .describe("Hide these accounts from your home timeline, so the list is the only place you see them."),
    ...accountArg,
  },
  risk: "write",
  summary: (a) => `create the list "${a.title}"`,
  handler: async ({ title, replies_policy, exclusive, account }, ctx) => {
    const chosen = ctx.account(account);
    const l = await ctx.client.call<Any>(chosen, "/api/v1/lists", {
      method: "POST",
      form: { title, replies_policy, exclusive },
    });
    return { id: l.id, title: l.title };
  },
});

const deleteList = defineTool({
  name: "delete_list",
  title: "Delete a list",
  description: "Delete a list. The accounts on it are not affected, only the list. Needs confirm: true.",
  schema: { id: z.string(), ...accountArg, ...confirmArg },
  risk: "destructive",
  summary: (a) => `delete list ${a.id}`,
  handler: async ({ id, account }, ctx) => {
    const chosen = ctx.account(account);
    await ctx.client.call(chosen, `/api/v1/lists/${id}`, { method: "DELETE" });
    return { deleted: id };
  },
});

const getListMembers = defineTool({
  name: "get_list_members",
  title: "List the accounts on a list",
  description: "The accounts on one of your lists.",
  schema: {
    id: z.string(),
    limit: z.number().int().min(1).max(400).optional().describe("How many. Default 40."),
    ...accountArg,
  },
  risk: "read",
  handler: async ({ id, limit, account }, ctx) => {
    const chosen = ctx.account(account);
    const result = await ctx.client.paginate<Any>(
      chosen,
      `/api/v1/lists/${id}/accounts`,
      {},
      clamp(limit, 40, 400),
    );
    return renderAccounts(result.items, { source: `list ${id}`, nextMaxId: result.nextMaxId });
  },
});

const addToList = defineTool({
  name: "add_to_list",
  title: "Add accounts to a list",
  description:
    "Add accounts to a list. You have to already follow an account before you can put it on a list, which is the error people hit here.",
  schema: {
    id: z.string().describe("The list id."),
    accts: z.array(z.string()).min(1).max(40).describe("Handles or ids to add."),
    ...accountArg,
  },
  risk: "write",
  summary: (a) => `add ${a.accts.length} account(s) to list ${a.id}`,
  handler: async ({ id, accts, account }, ctx) => {
    const chosen = ctx.account(account);
    const ids = await Promise.all(accts.map((a) => resolveAccountId(ctx as never, chosen, a)));
    await ctx.client.call(chosen, `/api/v1/lists/${id}/accounts`, {
      method: "POST",
      form: { account_ids: ids },
    });
    return { list: id, added: accts.length, accts };
  },
});

const removeFromList = defineTool({
  name: "remove_from_list",
  title: "Remove accounts from a list",
  description: "Remove accounts from a list. They are not unfollowed.",
  schema: {
    id: z.string(),
    accts: z.array(z.string()).min(1).max(40),
    ...accountArg,
  },
  risk: "write",
  summary: (a) => `remove ${a.accts.length} account(s) from list ${a.id}`,
  handler: async ({ id, accts, account }, ctx) => {
    const chosen = ctx.account(account);
    const ids = await Promise.all(accts.map((a) => resolveAccountId(ctx as never, chosen, a)));
    await ctx.client.call(chosen, `/api/v1/lists/${id}/accounts`, {
      method: "DELETE",
      form: { account_ids: ids },
    });
    return { list: id, removed: accts.length, accts };
  },
});

const getAnnouncements = defineTool({
  name: "get_announcements",
  title: "Read instance announcements",
  description:
    "Announcements from the people who run your instance: downtime, rule changes, moderation decisions. Worth checking when something stops working.",
  schema: {
    include_read: z.boolean().optional().describe("Include ones already dismissed. Default false."),
    ...accountArg,
  },
  risk: "read",
  handler: async ({ include_read, account }, ctx) => {
    const chosen = ctx.account(account);
    const rows = await ctx.client.call<Any[]>(chosen, "/api/v1/announcements", {
      query: { with_dismissed: include_read ?? false },
    });
    const { htmlToMarkdown } = await import("../content/html.js");
    return {
      count: (rows ?? []).length,
      announcements: (rows ?? []).map((a) => ({
        id: a.id,
        published_at: a.published_at,
        read: Boolean(a.read),
        content: htmlToMarkdown(a.content ?? ""),
      })),
    };
  },
});

export const notificationTools: AnyToolSpec[] = [
  getNotifications as AnyToolSpec,
  getReadPosition as AnyToolSpec,
  markRead as AnyToolSpec,
  dismissNotification as AnyToolSpec,
  clearNotifications as AnyToolSpec,
  getLists as AnyToolSpec,
  createList as AnyToolSpec,
  deleteList as AnyToolSpec,
  getListMembers as AnyToolSpec,
  addToList as AnyToolSpec,
  removeFromList as AnyToolSpec,
  getAnnouncements as AnyToolSpec,
];
