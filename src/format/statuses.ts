/**
 * Rendering statuses for a model to read.
 *
 * Both reference servers return raw API JSON. A single 40-status timeline page
 * is tens of thousands of tokens of account objects, emoji arrays, media
 * metadata and `application` blocks, and the model has to find the text inside
 * it. The tagged format below runs about a tenth the size and puts the text
 * where a model expects it.
 *
 * Rules that matter:
 *
 *   - Timestamps are ISO-8601 UTC, so two of them can be compared.
 *   - Every attribute and every body is escaped.
 *   - Content is markdown converted from Mastodon's HTML, with link targets
 *     taken from `href` rather than the deliberately-truncated visible text.
 *   - A boost is a `<boost>` wrapper around the original, not a flattened copy,
 *     so "who said this" is never ambiguous.
 *   - A content warning is an attribute, not hidden text. A model summarising a
 *     timeline needs to know the body was behind a warning.
 */

import { htmlToMarkdown, preview } from "../content/html.js";
import { escapeXml } from "../content/text.js";

type Any = Record<string, any>;

/** ISO-8601 in UTC, or the raw value when it will not parse. */
function ts(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function attr(name: string, value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  return ` ${name}="${escapeXml(value)}"`;
}

function pad(depth: number): string {
  return "  ".repeat(depth);
}

function engagement(status: Any): string {
  const parts = [
    `${status.favourites_count ?? 0} favourites`,
    `${status.reblogs_count ?? 0} boosts`,
    `${status.replies_count ?? 0} replies`,
  ];
  return parts.join(", ");
}

function renderMedia(status: Any, depth: number): string {
  const p = pad(depth);
  let out = "";
  for (const m of status.media_attachments ?? []) {
    out += `${p}<media`;
    out += attr("type", m.type);
    out += attr("url", m.url ?? m.preview_url);
    out += attr("alt", m.description || undefined);
    // No alt text is an accessibility problem worth surfacing, not hiding.
    if (!m.description) out += ` missing_alt="true"`;
    out += ` />\n`;
  }
  return out;
}

function renderPoll(poll: Any, depth: number): string {
  if (!poll) return "";
  const p = pad(depth);
  let out = `${p}<poll`;
  out += attr("id", poll.id);
  out += attr("expires_at", ts(poll.expires_at));
  out += ` expired="${Boolean(poll.expired)}"`;
  out += ` multiple="${Boolean(poll.multiple)}"`;
  out += attr("votes", poll.votes_count);
  if (poll.voted !== undefined) out += ` you_voted="${Boolean(poll.voted)}"`;
  out += ">\n";
  for (const [index, option] of (poll.options ?? []).entries()) {
    out += `${p}  <option index="${index}"${attr("votes", option.votes_count)}>${escapeXml(option.title)}</option>\n`;
  }
  out += `${p}</poll>\n`;
  return out;
}

function renderCard(card: Any, depth: number): string {
  if (!card) return "";
  const p = pad(depth);
  let out = `${p}<link_preview`;
  out += attr("url", card.url);
  out += attr("title", card.title);
  out += attr("author", card.author_name || undefined);
  out += ">\n";
  if (card.description) out += `${p}  <description>${escapeXml(card.description)}</description>\n`;
  out += `${p}</link_preview>\n`;
  return out;
}

export type RenderOptions = {
  /** Mark this status as the one the caller asked about. */
  requested?: boolean;
  /** Renders replies nested under this status, at whatever depth they land. */
  renderReplies?: (depth: number) => string;
  /** The account that boosted this, when it arrived via a boost. */
  boostedBy?: Any;
};

/** One status, and anything hanging off it. Every path renders through here. */
export function renderStatus(status: Any, options: RenderOptions = {}, depth = 0): string {
  if (!status?.id) return "";

  // A boost is a wrapper whose `reblog` holds the real status. Flattening it
  // attributes someone else's words to the booster.
  if (status.reblog) {
    const p = pad(depth);
    const by = status.account ?? {};
    let out = `${p}<boost`;
    out += attr("by", by.acct);
    out += attr("by_name", by.display_name);
    out += attr("at", ts(status.created_at));
    out += attr("boost_id", status.id);
    out += ">\n";
    out += renderStatus(status.reblog, { ...options, boostedBy: by }, depth + 1);
    out += `${p}</boost>\n`;
    return out;
  }

  const p = pad(depth);
  const account = status.account ?? {};

  let out = `${p}<status`;
  out += attr("id", status.id);
  out += attr("url", status.url ?? status.uri);
  out += attr("author", account.acct);
  out += attr("author_name", account.display_name);
  if (account.bot) out += ` bot="true"`;
  out += attr("posted_at", ts(status.created_at));
  if (status.edited_at) out += attr("edited_at", ts(status.edited_at));
  out += attr("visibility", status.visibility);
  if (status.in_reply_to_id) out += attr("in_reply_to", status.in_reply_to_id);
  if (status.language) out += attr("language", status.language);
  if (status.spoiler_text) out += attr("content_warning", status.spoiler_text);
  if (status.sensitive) out += ` sensitive="true"`;
  if (status.pinned) out += ` pinned="true"`;
  // Viewer state, on an authenticated read. Exactly what a model needs before
  // it decides whether to favourite, boost or reply.
  if (status.favourited) out += ` you_favourited="true"`;
  if (status.reblogged) out += ` you_boosted="true"`;
  if (status.bookmarked) out += ` you_bookmarked="true"`;
  if (options.requested) out += ` requested="true"`;
  out += ">\n";

  out += `${p}  <content>${escapeXml(htmlToMarkdown(status.content ?? "", status.mentions ?? []))}</content>\n`;
  out += renderMedia(status, depth + 1);
  out += renderPoll(status.poll, depth + 1);
  out += renderCard(status.card, depth + 1);
  out += `${p}  <engagement>${engagement(status)}</engagement>\n`;

  const replies = options.renderReplies?.(depth + 2);
  if (replies) out += `${p}  <replies>\n${replies}${p}  </replies>\n`;

  out += `${p}</status>\n`;
  return out;
}

/** A timeline page. Flat, in the order the instance sent it. */
export function renderStatuses(
  statuses: Any[],
  meta: { source?: string; nextMaxId?: string; note?: string } = {},
): string {
  let out = `<statuses count="${statuses.length}"`;
  out += attr("source", meta.source);
  out += attr("next_max_id", meta.nextMaxId);
  out += ">\n";
  if (meta.note) out += `  <note>${escapeXml(meta.note)}</note>\n`;
  for (const status of statuses) out += renderStatus(status, {}, 1);
  out += "</statuses>\n";
  return out;
}

/**
 * A conversation: ancestors, the requested status, then descendants.
 *
 * Mastodon's `/context` returns two flat arrays rather than a tree, so the
 * nesting has to be rebuilt from `in_reply_to_id`. Both reference servers hand
 * the two arrays over unshaped, which leaves the model to work out who replied
 * to whom.
 */
export function renderContext(status: Any, context: Any): string {
  const ancestors: Any[] = context?.ancestors ?? [];
  const descendants: Any[] = context?.descendants ?? [];

  const childrenOf = new Map<string, Any[]>();
  for (const d of descendants) {
    const parent = String(d.in_reply_to_id ?? "");
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent)!.push(d);
  }

  const seen = new Set<string>();
  const renderSubtree = (node: Any, depth: number): string =>
    renderStatus(
      node,
      {
        renderReplies: (childDepth) =>
          (childrenOf.get(String(node.id)) ?? [])
            .filter((child) => !seen.has(String(child.id)) && seen.add(String(child.id)) !== undefined)
            .map((child) => renderSubtree(child, childDepth))
            .join(""),
      },
      depth,
    );

  // The ancestor chain wraps the requested status, oldest outermost.
  let body = renderStatus(
    status,
    {
      requested: true,
      renderReplies: (childDepth) =>
        (childrenOf.get(String(status.id)) ?? [])
          .filter((child) => !seen.has(String(child.id)) && seen.add(String(child.id)) !== undefined)
          .map((child) => renderSubtree(child, childDepth))
          .join(""),
    },
    ancestors.length + 1,
  );

  for (let i = ancestors.length - 1; i >= 0; i--) {
    const ancestor = ancestors[i];
    if (!ancestor) continue;
    const inner = body;
    body = renderStatus(ancestor, { renderReplies: () => inner }, i + 1);
  }

  // Anything whose parent never appeared, e.g. a reply to a deleted status.
  const orphans = descendants.filter((d) => !seen.has(String(d.id)));
  const orphaned = orphans.length
    ? `  <detached count="${orphans.length}" note="replies whose parent is not in this thread">\n${orphans.map((o) => renderStatus(o, {}, 2)).join("")}  </detached>\n`
    : "";

  return `<statuses source="thread">\n${body}${orphaned}</statuses>\n`;
}

/** A list of accounts, for followers, follows, search and suggestions. */
export function renderAccounts(
  accounts: Any[],
  meta: { source?: string; nextMaxId?: string } = {},
): string {
  let out = `<accounts count="${accounts.length}"`;
  out += attr("source", meta.source);
  out += attr("next_max_id", meta.nextMaxId);
  out += ">\n";
  for (const a of accounts) {
    out += `  <account`;
    out += attr("id", a.id);
    out += attr("acct", a.acct);
    out += attr("name", a.display_name);
    out += attr("url", a.url);
    out += attr("followers", a.followers_count);
    out += attr("following", a.following_count);
    out += attr("statuses", a.statuses_count);
    out += attr("created_at", ts(a.created_at));
    if (a.bot) out += ` bot="true"`;
    if (a.locked) out += ` locked="true"`;
    if (a.suspended) out += ` suspended="true"`;
    const bio = htmlToMarkdown(a.note ?? "");
    if (bio) {
      out += `>\n    <bio>${escapeXml(bio)}</bio>\n  </account>\n`;
    } else {
      out += ` />\n`;
    }
  }
  out += `</accounts>\n`;
  return out;
}

/** One account in full, for a profile lookup. */
export function renderAccount(a: Any, relationship?: Any): string {
  let out = `<account`;
  out += attr("id", a.id);
  out += attr("acct", a.acct);
  out += attr("name", a.display_name);
  out += attr("url", a.url);
  out += attr("created_at", ts(a.created_at));
  if (a.bot) out += ` bot="true"`;
  if (a.locked) out += ` locked="true"`;
  out += ">\n";

  const bio = htmlToMarkdown(a.note ?? "");
  if (bio) out += `  <bio>${escapeXml(bio)}</bio>\n`;
  out += `  <counts followers="${a.followers_count ?? 0}" following="${a.following_count ?? 0}" statuses="${a.statuses_count ?? 0}" />\n`;

  // Profile metadata fields, the four link/label rows on a Mastodon profile.
  for (const field of a.fields ?? []) {
    const value = htmlToMarkdown(field.value ?? "");
    out += `  <field${attr("name", field.name)}${field.verified_at ? ` verified="true"` : ""}>${escapeXml(value)}</field>\n`;
  }

  if (relationship) {
    out += `  <relationship following="${Boolean(relationship.following)}" followed_by="${Boolean(relationship.followed_by)}"`;
    out += ` muting="${Boolean(relationship.muting)}" blocking="${Boolean(relationship.blocking)}" blocked_by="${Boolean(relationship.blocked_by)}"`;
    out += ` requested="${Boolean(relationship.requested)}" notifying="${Boolean(relationship.notifying)}" />\n`;
  }

  out += `</account>\n`;
  return out;
}

/** Notifications, grouped so a model can see what needs a reply. */
export function renderNotifications(
  notifications: Any[],
  meta: { nextMaxId?: string } = {},
): string {
  let out = `<notifications count="${notifications.length}"`;
  out += attr("next_max_id", meta.nextMaxId);
  out += ">\n";
  for (const n of notifications) {
    out += `  <notification`;
    out += attr("id", n.id);
    out += attr("type", n.type);
    out += attr("from", n.account?.acct);
    out += attr("from_name", n.account?.display_name);
    out += attr("at", ts(n.created_at));
    if (n.status?.id) out += attr("status_id", n.status.id);
    if (n.status?.url) out += attr("status_url", n.status.url);
    const text = n.status ? preview(n.status.content ?? "", n.status.mentions ?? [], 200) : "";
    if (text) {
      out += `>\n    <content>${escapeXml(text)}</content>\n  </notification>\n`;
    } else {
      out += ` />\n`;
    }
  }
  out += `</notifications>\n`;
  return out;
}
