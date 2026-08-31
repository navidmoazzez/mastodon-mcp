/**
 * Status content, in and out.
 *
 * Mastodon stores a status as **HTML**, not plain text. What comes back looks
 * like this:
 *
 *   <p>Shipping today <a href="https://navid.me/x/very/long" rel="nofollow">
 *     <span class="invisible">https://</span><span class="ellipsis">navid.me/x/ver</span
 *     ><span class="invisible">y/long</span></a> thanks
 *     <span class="h-card"><a href="https://m.example/@alice" class="u-url mention"
 *       >@<span>alice</span></a></span></p>
 *
 * Handing that to a model as-is is unreadable, and stripping every tag with a
 * regex is worse than it looks: the visible text of a link is deliberately
 * truncated by those `invisible` and `ellipsis` spans, so a stripped status says
 * `navid.me/x/ver` and the real URL is gone. A model that follows it gets a 404.
 *
 * So: convert to markdown, take link targets from `href` rather than from the
 * visible text, and rebuild mentions as full `@user@instance` handles.
 */

/** Decode the entities Mastodon actually emits. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    // Ampersand last, so &amp;lt; decodes to &lt; and not to <.
    .replace(/&amp;/g, "&");
}

/** Strip tags from a fragment and decode what is left. */
function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ""));
}

type Mention = { url: string; acct: string };

/**
 * Turn a status's HTML into markdown.
 *
 * `mentions` comes from the status object itself. Mastodon's mention markup
 * carries only the local username, so `@alice` on a remote instance is
 * indistinguishable from a local `@alice` unless the mention list is consulted,
 * and replying to the wrong one is a real mistake to make.
 */
export function htmlToMarkdown(html: string, mentions: Mention[] = []): string {
  if (!html) return "";
  let s = html;

  // Block structure first, before the tags are gone.
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/p>\s*<p[^>]*>/gi, "\n\n");
  s = s.replace(/<\/?p[^>]*>/gi, "");
  s = s.replace(/<\/li>\s*<li[^>]*>/gi, "\n- ");
  s = s.replace(/<li[^>]*>/gi, "\n- ");
  s = s.replace(/<\/(ul|ol|li)>/gi, "");
  s = s.replace(/<blockquote[^>]*>/gi, "\n> ");
  s = s.replace(/<\/blockquote>/gi, "\n");

  // Anchors, longest-specific first. Each one consumes the whole element.
  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_m, attrs: string, inner: string) => {
    const href = attrs.match(/href="([^"]*)"/i)?.[1] ?? "";
    const cls = attrs.match(/class="([^"]*)"/i)?.[1] ?? "";
    const visible = textOf(inner).trim();

    // Hashtags before mentions. Mastodon marks a hashtag anchor
    // class="mention hashtag", so a mention check that runs first claims it and
    // emits "@#tag".
    if (/\bhashtag\b/.test(cls) || /\brel="[^"]*\btag\b/i.test(attrs)) {
      return visible.startsWith("#") ? visible : `#${visible.replace(/^#/, "")}`;
    }

    // A mention. The markup holds only the local part, so match on the profile
    // URL to recover the full acct, and fall back to the visible text.
    if (/\bmention\b/.test(cls) || visible.startsWith("@")) {
      const hit = mentions.find((m) => m.url === href);
      if (hit) return `@${hit.acct}`;
      return visible.startsWith("@") ? visible : `@${visible}`;
    }

    // Anything else. The href is the truth: the visible text is deliberately
    // truncated by the invisible/ellipsis spans, so showing it loses the target.
    if (!href) return visible;
    const decodedHref = decodeEntities(href);
    // A bare URL rather than markdown autolink syntax. `<url>` would be eaten by
    // the tag strip that runs at the end of this function, and a URL on its own
    // is unambiguous anyway.
    return visible && visible !== decodedHref && !decodedHref.includes(visible.replace(/…$/, ""))
      ? `[${visible}](${decodedHref})`
      : decodedHref;
  });

  // Custom emoji shortcodes survive as :name:, which is what a person types.
  s = s.replace(/<img[^>]*class="[^"]*\bemojione\b[^"]*"[^>]*alt="([^"]*)"[^>]*>/gi, "$1");

  s = textOf(s);

  // Collapse the blank lines the block rules introduce, without flattening the
  // author's own paragraph breaks.
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Plain text for a preview, with links kept whole.
 *
 * Used where a full body would drown the output, e.g. a notification list.
 * Truncates on a word boundary rather than mid-URL.
 */
export function preview(html: string, mentions: Mention[] = [], max = 200): string {
  const text = htmlToMarkdown(html, mentions).replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
