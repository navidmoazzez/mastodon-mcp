/**
 * Measuring and escaping text.
 *
 * Mastodon's character limit is **per instance**, not a constant. mastodon.social
 * allows 500; infosec.exchange allows 11,000. Every existing Mastodon MCP server
 * hardcodes 500, which silently refuses a legal 2,000-character post on half the
 * fediverse. The limit is read from the instance and cached, see `api/instance.ts`.
 *
 * What Mastodon counts is also not what `String.length` counts: a URL counts as
 * 23 characters no matter how long it is, and a remote mention counts only the
 * local part. Both rules are implemented in `countCharacters`.
 */

const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined;

/** Count user-perceived characters rather than UTF-16 code units. */
export function graphemeLength(text: string): number {
  if (!text) return 0;
  if (!segmenter) return [...text].length;
  let n = 0;
  for (const _ of segmenter.segment(text)) n++;
  return n;
}

/**
 * Every URL counts as this many characters regardless of its real length.
 *
 * Mastodon shortens links for counting purposes, so a 300-character tracking URL
 * costs 23. A naive length check refuses posts the server would have accepted.
 */
export const URL_WEIGHT = 23;

const URL_RE = /https?:\/\/\S+/gi;
/** A mention: only the @user part counts, the @instance part is free. */
const MENTION_RE = /(^|[^\w/])@([a-z0-9_]+)@[a-z0-9.-]+\b/gi;

/**
 * Count a status the way Mastodon counts it.
 *
 * Not `text.length`. Links weigh 23 whatever their length, and the domain half
 * of a remote mention is free. Both rules come from Mastodon's own
 * `CharacterCounter`, and neither reference server implements either.
 */
export function countCharacters(text: string): number {
  if (!text) return 0;
  let counted = text.replace(URL_RE, "x".repeat(URL_WEIGHT));
  counted = counted.replace(MENTION_RE, (_m, lead: string, user: string) => `${lead}@${user}`);
  return graphemeLength(counted);
}

/** Throws with the real overage, measured against this instance's own limit. */
export function assertStatusLength(text: string, maxCharacters: number, instance: string): void {
  const n = countCharacters(text);
  if (n > maxCharacters) {
    throw new Error(
      `Status is ${n} characters; ${instance} allows ${maxCharacters}. Trim ${n - maxCharacters}, or split it into a thread with post_thread. Links count as ${URL_WEIGHT} characters each regardless of length.`,
    );
  }
}

/** Escape the five XML entities. Applied to every attribute and every body. */
export function escapeXml(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
