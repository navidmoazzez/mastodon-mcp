/** Which accounts are connected, who we are, and what the instance allows. */

import { z } from "zod";
import { instanceLimits } from "../api/instance.js";
import { renderAccount } from "../format/statuses.js";
import { escapeXml } from "../content/text.js";
import { accountArg, defineTool, type AnyToolSpec } from "./kit.js";

const listAccounts = defineTool({
  name: "list_accounts",
  title: "List connected accounts",
  description:
    "Every Mastodon account this server can act as, and which instance each lives on. Mastodon is federated, so an account is a token plus an instance: the same handle on two servers is two different people. Use the handle from here as the `account` argument on any other tool.",
  schema: {},
  risk: "read",
  handler: async (_args, ctx) => ({
    count: ctx.client.accounts.length,
    default: ctx.client.accounts.length ? ctx.account().handle || ctx.account().instance : null,
    accounts: ctx.client.accounts.map((a) => ({ handle: a.handle || "(unverified)", instance: a.instance })),
    ...(ctx.client.accounts.length === 0
      ? { note: "No account configured. Run `mastodon-mcp login <your-instance>`." }
      : {}),
  }),
});

const whoami = defineTool({
  name: "whoami",
  title: "Verify credentials",
  description:
    "Authenticate against the instance and return the live profile. Use this to confirm a token still works, or when the user says 'me' or 'my' and you need their handle.",
  schema: { ...accountArg },
  risk: "read",
  handler: async ({ account }, ctx) => {
    const chosen = ctx.account(account);
    const me = await ctx.client.call<Record<string, any>>(chosen, "/api/v1/accounts/verify_credentials");
    return renderAccount(me);
  },
});

const getInstanceInfo = defineTool({
  name: "get_instance_info",
  title: "Read the instance's rules and limits",
  description:
    "What this instance actually allows: the character limit, how many attachments and poll options, media size ceilings, the software version, and the server rules. Worth reading before drafting anything long, because the character limit is per instance and ranges from 500 to 11,000.",
  schema: { ...accountArg },
  risk: "read",
  handler: async ({ account }, ctx) => {
    const chosen = ctx.account(account);
    const limits = await instanceLimits(ctx.client, chosen);

    let rules: Array<Record<string, any>> = [];
    try {
      rules = await ctx.client.call<Array<Record<string, any>>>(chosen, "/api/v1/instance/rules", {
        anonymous: true,
      });
    } catch {
      // Older servers and non-Mastodon software do not publish rules.
    }

    let out = `<instance`;
    out += ` url="${escapeXml(limits.instance)}"`;
    out += ` title="${escapeXml(limits.title)}"`;
    out += ` version="${escapeXml(limits.version)}"`;
    out += ` mastodon="${limits.looksLikeMastodon}"`;
    out += ">\n";
    out += `  <limits max_characters="${limits.maxCharacters}" max_media="${limits.maxMediaAttachments}"`;
    out += ` max_poll_options="${limits.maxPollOptions}" max_poll_option_characters="${limits.maxPollCharacters}"`;
    out += ` image_size_mb="${(limits.imageSizeLimit / 1e6).toFixed(0)}" video_size_mb="${(limits.videoSizeLimit / 1e6).toFixed(0)}" />\n`;
    for (const rule of rules) {
      out += `  <rule id="${escapeXml(rule.id)}">${escapeXml(rule.text)}</rule>\n`;
    }
    out += `</instance>\n`;
    return out;
  },
});

const updateProfile = defineTool({
  name: "update_profile",
  title: "Edit your profile",
  description:
    "Change your display name, bio, or the four metadata fields on your profile. Only the arguments you pass are changed. Public the moment it runs, so it needs confirm: true.",
  schema: {
    display_name: z.string().optional().describe("The name shown above your handle."),
    note: z.string().optional().describe("Your bio."),
    fields: z
      .array(z.object({ name: z.string(), value: z.string() }))
      .max(4)
      .optional()
      .describe("The metadata rows on your profile. A URL here can be verified with a rel=me link back."),
    bot: z.boolean().optional().describe("Mark the account as automated."),
    locked: z.boolean().optional().describe("Require approval for new followers."),
    discoverable: z.boolean().optional().describe("Allow the account to appear in the profile directory."),
    ...accountArg,
    confirm: z
      .boolean()
      .optional()
      .describe("Must be true. This changes a public profile immediately."),
  },
  risk: "destructive",
  public: true,
  summary: (a) => `update profile${a.display_name ? ` name to "${a.display_name}"` : ""}`,
  handler: async (args, ctx) => {
    const chosen = ctx.account(args.account);
    const form: Record<string, unknown> = {
      display_name: args.display_name,
      note: args.note,
      bot: args.bot,
      locked: args.locked,
      discoverable: args.discoverable,
    };
    // Fields are indexed rather than repeated, unlike every other Mastodon array.
    args.fields?.forEach((field, index) => {
      form[`fields_attributes[${index}][name]`] = field.name;
      form[`fields_attributes[${index}][value]`] = field.value;
    });

    const me = await ctx.client.call<Record<string, any>>(
      chosen,
      "/api/v1/accounts/update_credentials",
      { method: "PATCH", form },
    );
    return renderAccount(me);
  },
});

export const accountTools: AnyToolSpec[] = [
  listAccounts as AnyToolSpec,
  whoami as AnyToolSpec,
  getInstanceInfo as AnyToolSpec,
  updateProfile as AnyToolSpec,
];
