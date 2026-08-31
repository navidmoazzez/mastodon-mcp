/**
 * Posting, editing, and reading a thread.
 *
 * `edit_status` is the tool that carries the most difference from the reference
 * servers. Mastodon is the only network in this family that lets you edit a
 * published post, keeping a public revision history rather than replacing it
 * silently. Neither reference server exposes it, so the only way to fix a typo
 * through them is to delete and repost, which throws away every boost, reply
 * and favourite the post had. That is a real cost paid for a missing endpoint.
 *
 * `post_thread` exists because a character limit means threads are the normal
 * way to say anything long, and building one by hand is one tool call per part
 * with the previous id threaded back through each time.
 */

import { z } from "zod";
import { assertStatusLength, countCharacters } from "../content/text.js";
import { htmlToMarkdown } from "../content/html.js";
import { uploadMedia, type Attachment } from "../content/media.js";
import { instanceLimits } from "../api/instance.js";
import { ValidationError } from "../api/errors.js";
import { renderContext, renderStatus, renderStatuses } from "../format/statuses.js";
import type { Account } from "../config.js";
import { accountArg, clamp, confirmArg, defineTool, type ToolContext, type AnyToolSpec } from "./kit.js";

const mediaSchema = z.object({
  url: z.string().describe("Public http(s) URL, or a data: URI."),
  description: z
    .string()
    .default("")
    .describe("Alt text. Write real alt text: Mastodon's culture treats a missing description as rude, and some instances auto-flag it."),
  focus: z
    .string()
    .optional()
    .describe("Visual centre as 'x,y', each between -1 and 1, e.g. '0,0.5' for a face near the top. Mastodon crops thumbnails around this point."),
});

const visibilitySchema = z
  .enum(["public", "unlisted", "private", "direct"])
  .describe(
    "public appears everywhere; unlisted skips the public timelines but is still reachable; private goes to followers only; direct goes only to the accounts mentioned.",
  );

type PostArgs = {
  status: string;
  media?: { url: string; description: string; focus?: string }[];
  in_reply_to_id?: string;
  spoiler_text?: string;
  visibility?: "public" | "unlisted" | "private" | "direct";
  sensitive?: boolean;
  language?: string;
  scheduled_at?: string;
  poll_options?: string[];
  poll_expires_in?: number;
  poll_multiple?: boolean;
};

/** Build the form body for a status, uploading any media it references. */
async function buildStatusForm(
  ctx: ToolContext,
  chosen: Account,
  args: PostArgs,
): Promise<Record<string, unknown>> {
  const limits = await instanceLimits(ctx.client, chosen);
  assertStatusLength(args.status, limits.maxCharacters, limits.instance);

  if (args.media?.length && args.poll_options?.length) {
    throw new ValidationError(
      "A status carries media or a poll, not both.",
      422,
      "(local)",
      chosen.instance,
    );
  }
  if (args.media && args.media.length > limits.maxMediaAttachments) {
    throw new ValidationError(
      `${limits.instance} allows ${limits.maxMediaAttachments} attachments, not ${args.media.length}.`,
      422,
      "(local)",
      chosen.instance,
    );
  }
  if (args.poll_options && args.poll_options.length > limits.maxPollOptions) {
    throw new ValidationError(
      `${limits.instance} allows ${limits.maxPollOptions} poll options, not ${args.poll_options.length}.`,
      422,
      "(local)",
      chosen.instance,
    );
  }

  const media_ids = args.media?.length
    ? await Promise.all(
        args.media.map((m) => uploadMedia(ctx.client, chosen, m as Attachment, ctx.config.requestTimeoutMs)),
      )
    : undefined;

  const form: Record<string, unknown> = {
    status: args.status,
    visibility: args.visibility ?? "public",
    language: args.language ?? "en",
    sensitive: args.sensitive ?? false,
    in_reply_to_id: args.in_reply_to_id,
    spoiler_text: args.spoiler_text,
    scheduled_at: args.scheduled_at,
    media_ids,
  };

  if (args.poll_options?.length) {
    // Poll options are an indexed array, not repeated `poll[options][]` keys.
    args.poll_options.forEach((option, index) => {
      form[`poll[options][${index}]`] = option;
    });
    form["poll[expires_in]"] = args.poll_expires_in ?? 86_400;
    form["poll[multiple]"] = args.poll_multiple ?? false;
  }

  return form;
}

const postStatus = defineTool({
  name: "post_status",
  title: "Post a status",
  description:
    "Publish a status. Handles text, media with alt text, a content warning, a poll, a reply, visibility, and native scheduling. The character limit is per instance, so check get_instance_info before drafting anything long: it ranges from 500 to 11,000. Public the moment it runs, so it needs confirm: true.",
  schema: {
    status: z.string().describe("The body. Write links and @mentions normally; Mastodon linkifies them."),
    ...accountArg,
    media: z.array(mediaSchema).max(20).optional().describe("Attachments, up to whatever the instance allows."),
    in_reply_to_id: z.string().optional().describe("The status being replied to."),
    spoiler_text: z
      .string()
      .optional()
      .describe("Content warning. The body is hidden behind it until the reader expands it. Used far more on Mastodon than on other networks."),
    visibility: visibilitySchema.optional(),
    sensitive: z.boolean().optional().describe("Blur the media until the reader taps it."),
    language: z.string().optional().describe("ISO 639 code. Instances use it to filter timelines. Defaults to en."),
    scheduled_at: z
      .string()
      .optional()
      .describe("ISO 8601. Mastodon schedules natively, minimum five minutes ahead. Returns a scheduled status, not a published one."),
    poll_options: z.array(z.string()).min(2).max(10).optional(),
    poll_expires_in: z.number().int().min(300).optional().describe("Poll lifetime in seconds. Default 86400."),
    poll_multiple: z.boolean().optional().describe("Allow more than one choice."),
    ...confirmArg,
  },
  risk: "destructive",
  public: true,
  summary: (a) => `post ${countCharacters(a.status)} chars: ${a.status.slice(0, 80)}`,
  handler: async (args, ctx) => {
    const chosen = ctx.account(args.account);
    const form = await buildStatusForm(ctx, chosen, args as PostArgs);
    const result = await ctx.client.call<Record<string, any>>(chosen, "/api/v1/statuses", {
      method: "POST",
      form,
    });

    if (args.scheduled_at) {
      return {
        scheduled_id: result.id,
        scheduled_at: result.scheduled_at,
        posted_as: chosen.handle,
        note: "Not published yet. Cancel with cancel_scheduled_status, or move it with reschedule_status.",
      };
    }
    return {
      id: result.id,
      url: result.url,
      posted_as: chosen.handle,
      characters: countCharacters(args.status),
      visibility: result.visibility,
    };
  },
});

const postThread = defineTool({
  name: "post_thread",
  title: "Post a thread",
  description:
    "Publish several statuses as one thread, each replying to the last. Every part is checked against this instance's character limit before anything is posted, so a thread never half-publishes because part four was too long. Media, a poll and the content warning apply to the first part. Public the moment it runs, so it needs confirm: true.",
  schema: {
    parts: z.array(z.string()).min(1).max(50).describe("The parts, in order."),
    ...accountArg,
    media: z.array(mediaSchema).max(20).optional().describe("Attachments on the first part."),
    in_reply_to_id: z.string().optional().describe("Start the thread as a reply to this status."),
    spoiler_text: z.string().optional().describe("Content warning, applied to every part."),
    visibility: visibilitySchema.optional(),
    language: z.string().optional(),
    ...confirmArg,
  },
  risk: "destructive",
  public: true,
  summary: (a) => `post a ${a.parts.length}-part thread starting: ${a.parts[0]?.slice(0, 60)}`,
  handler: async (args, ctx) => {
    const chosen = ctx.account(args.account);
    const limits = await instanceLimits(ctx.client, chosen);

    // Validate every part first. A thread that publishes three and fails on the
    // fourth leaves a public, truncated argument behind.
    args.parts.forEach((text, index) => {
      try {
        assertStatusLength(text, limits.maxCharacters, limits.instance);
      } catch (error) {
        throw new ValidationError(
          `Part ${index + 1} of ${args.parts.length}: ${(error as Error).message}`,
          422,
          "(local)",
          chosen.instance,
        );
      }
    });

    const posted: { id: string; url: string }[] = [];
    let replyTo = args.in_reply_to_id;

    for (const [index, status] of args.parts.entries()) {
      const form = await buildStatusForm(ctx, chosen, {
        status,
        media: index === 0 ? args.media : undefined,
        in_reply_to_id: replyTo,
        spoiler_text: args.spoiler_text,
        visibility: args.visibility,
        language: args.language,
      });
      const result = await ctx.client.call<Record<string, any>>(chosen, "/api/v1/statuses", {
        method: "POST",
        form,
      });
      posted.push({ id: result.id, url: result.url });
      replyTo = result.id;
    }

    return {
      parts: posted.length,
      url: posted[0]?.url,
      thread_root: posted[0]?.id,
      posted_as: chosen.handle,
      statuses: posted,
    };
  },
});

const editStatus = defineTool({
  name: "edit_status",
  title: "Edit a published status",
  description:
    "Change the text, content warning, media alt text or poll of a status that is already published. Mastodon keeps a public revision history and the post keeps its boosts, replies and favourites, which is why editing beats delete-and-repost. Call get_status_source first to get the exact text you are editing. Public the moment it runs, so it needs confirm: true.",
  schema: {
    id: z.string().describe("The status to edit."),
    status: z.string().describe("The full new body. This replaces the old text, it is not a patch."),
    ...accountArg,
    spoiler_text: z.string().optional().describe("New content warning. Pass an empty string to remove one."),
    sensitive: z.boolean().optional(),
    language: z.string().optional(),
    media_ids: z
      .array(z.string())
      .optional()
      .describe("Existing attachment ids to keep, in order. Omit to leave the media untouched."),
    ...confirmArg,
  },
  risk: "destructive",
  public: true,
  summary: (a) => `edit status ${a.id}`,
  handler: async (args, ctx) => {
    const chosen = ctx.account(args.account);
    const limits = await instanceLimits(ctx.client, chosen);
    assertStatusLength(args.status, limits.maxCharacters, limits.instance);

    const result = await ctx.client.call<Record<string, any>>(chosen, `/api/v1/statuses/${args.id}`, {
      method: "PUT",
      form: {
        status: args.status,
        spoiler_text: args.spoiler_text,
        sensitive: args.sensitive,
        language: args.language,
        media_ids: args.media_ids,
      },
    });
    return { id: result.id, url: result.url, edited_at: result.edited_at, characters: countCharacters(args.status) };
  },
});

const getStatusSource = defineTool({
  name: "get_status_source",
  title: "Read a status's original text",
  description:
    "The plain-text source of one of your own statuses, exactly as it was typed, plus its content warning. This is what to edit from: the rendered content is HTML with links rewritten, so editing that back would mangle every link in the post.",
  schema: { id: z.string(), ...accountArg },
  risk: "read",
  handler: async ({ id, account }, ctx) => {
    const chosen = ctx.account(account);
    const source = await ctx.client.call<Record<string, any>>(chosen, `/api/v1/statuses/${id}/source`);
    return { id: source.id, text: source.text, spoiler_text: source.spoiler_text };
  },
});

const getStatusHistory = defineTool({
  name: "get_status_history",
  title: "Read a status's edit history",
  description:
    "Every published version of a status, oldest first. Mastodon keeps edits public, so this works for anyone's post, not only your own.",
  schema: { id: z.string(), ...accountArg },
  risk: "read",
  handler: async ({ id, account }, ctx) => {
    const chosen = ctx.account(account);
    const versions = await ctx.client.call<Array<Record<string, any>>>(
      chosen,
      `/api/v1/statuses/${id}/history`,
    );
    return {
      id,
      versions: (versions ?? []).map((v, index) => ({
        version: index + 1,
        at: v.created_at,
        content: htmlToMarkdown(v.content ?? "", v.mentions ?? []),
        content_warning: v.spoiler_text || undefined,
      })),
    };
  },
});

const deleteStatus = defineTool({
  name: "delete_status",
  title: "Delete a status",
  description:
    "Delete one of your own statuses. This cannot be undone and it discards every boost, reply and favourite it had. To fix a mistake, prefer edit_status, which keeps all of that. Needs confirm: true.",
  schema: { id: z.string(), ...accountArg, ...confirmArg },
  risk: "destructive",
  summary: (a) => `delete status ${a.id}`,
  handler: async ({ id, account }, ctx) => {
    const chosen = ctx.account(account);
    await ctx.client.call(chosen, `/api/v1/statuses/${id}`, { method: "DELETE" });
    return { deleted: id };
  },
});

const getStatus = defineTool({
  name: "get_status",
  title: "Read one status",
  description: "A single status by id, with its media, poll, link preview and engagement counts.",
  schema: { id: z.string(), ...accountArg },
  risk: "read",
  handler: async ({ id, account }, ctx) => {
    const chosen = ctx.account(account);
    const status = await ctx.client.call<Record<string, any>>(chosen, `/api/v1/statuses/${id}`);
    return renderStatus(status, { requested: true });
  },
});

const getThread = defineTool({
  name: "get_thread",
  title: "Read a conversation",
  description:
    "A status together with everything above and below it, nested into the real reply tree. Mastodon returns two flat lists and leaves the structure to you; this rebuilds it. Read this before replying, so the reply lands with context.",
  schema: { id: z.string().describe("Any status in the thread."), ...accountArg },
  risk: "read",
  handler: async ({ id, account }, ctx) => {
    const chosen = ctx.account(account);
    const [status, context] = await Promise.all([
      ctx.client.call<Record<string, any>>(chosen, `/api/v1/statuses/${id}`),
      ctx.client.call<Record<string, any>>(chosen, `/api/v1/statuses/${id}/context`),
    ]);
    return renderContext(status, context);
  },
});

const listScheduled = defineTool({
  name: "list_scheduled_statuses",
  title: "List scheduled statuses",
  description: "Statuses queued with scheduled_at that have not published yet.",
  schema: { ...accountArg },
  risk: "read",
  handler: async ({ account }, ctx) => {
    const chosen = ctx.account(account);
    const rows = await ctx.client.call<Array<Record<string, any>>>(chosen, "/api/v1/scheduled_statuses");
    return {
      count: (rows ?? []).length,
      scheduled: (rows ?? []).map((r) => ({
        id: r.id,
        scheduled_at: r.scheduled_at,
        text: String(r.params?.text ?? "").slice(0, 200),
        visibility: r.params?.visibility,
      })),
    };
  },
});

const rescheduleStatus = defineTool({
  name: "reschedule_status",
  title: "Move a scheduled status",
  description: "Change when a scheduled status will publish. Minimum five minutes ahead.",
  schema: {
    id: z.string(),
    scheduled_at: z.string().describe("New ISO 8601 time."),
    ...accountArg,
  },
  risk: "write",
  summary: (a) => `reschedule ${a.id} to ${a.scheduled_at}`,
  handler: async ({ id, scheduled_at, account }, ctx) => {
    const chosen = ctx.account(account);
    const r = await ctx.client.call<Record<string, any>>(chosen, `/api/v1/scheduled_statuses/${id}`, {
      method: "PUT",
      form: { scheduled_at },
    });
    return { id: r.id, scheduled_at: r.scheduled_at };
  },
});

const cancelScheduled = defineTool({
  name: "cancel_scheduled_status",
  title: "Cancel a scheduled status",
  description: "Cancel a status that was scheduled but has not published.",
  schema: { id: z.string(), ...accountArg },
  risk: "write",
  summary: (a) => `cancel scheduled ${a.id}`,
  handler: async ({ id, account }, ctx) => {
    const chosen = ctx.account(account);
    await ctx.client.call(chosen, `/api/v1/scheduled_statuses/${id}`, { method: "DELETE" });
    return { cancelled: id };
  },
});

const getFavourites = defineTool({
  name: "get_favourites",
  title: "List statuses you favourited",
  description: "Statuses a connected account has favourited, newest first.",
  schema: {
    limit: z.number().int().min(1).max(200).optional().describe("How many. Pages automatically. Default 40."),
    ...accountArg,
  },
  risk: "read",
  handler: async ({ limit, account }, ctx) => {
    const chosen = ctx.account(account);
    const result = await ctx.client.paginate<Record<string, any>>(
      chosen,
      "/api/v1/favourites",
      {},
      clamp(limit, 40, 200),
    );
    return renderStatuses(result.items, { source: "favourites", nextMaxId: result.nextMaxId });
  },
});

const getBookmarks = defineTool({
  name: "get_bookmarks",
  title: "List statuses you bookmarked",
  description: "Statuses a connected account has bookmarked. Unlike favourites, bookmarks are private.",
  schema: {
    limit: z.number().int().min(1).max(200).optional().describe("How many. Pages automatically. Default 40."),
    ...accountArg,
  },
  risk: "read",
  handler: async ({ limit, account }, ctx) => {
    const chosen = ctx.account(account);
    const result = await ctx.client.paginate<Record<string, any>>(
      chosen,
      "/api/v1/bookmarks",
      {},
      clamp(limit, 40, 200),
    );
    return renderStatuses(result.items, { source: "bookmarks", nextMaxId: result.nextMaxId });
  },
});

export const statusTools: AnyToolSpec[] = [
  postStatus as AnyToolSpec,
  postThread as AnyToolSpec,
  editStatus as AnyToolSpec,
  getStatusSource as AnyToolSpec,
  getStatusHistory as AnyToolSpec,
  deleteStatus as AnyToolSpec,
  getStatus as AnyToolSpec,
  getThread as AnyToolSpec,
  listScheduled as AnyToolSpec,
  rescheduleStatus as AnyToolSpec,
  cancelScheduled as AnyToolSpec,
  getFavourites as AnyToolSpec,
  getBookmarks as AnyToolSpec,
];
