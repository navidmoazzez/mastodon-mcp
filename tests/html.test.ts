import { describe, expect, it } from "vitest";
import { decodeEntities, htmlToMarkdown, preview } from "../src/content/html.js";

/** Exactly the markup Mastodon emits for a long link. */
const LONG_LINK =
  `<a href="https://navid.me/x/very/long/path?utm=1" rel="nofollow noopener">` +
  `<span class="invisible">https://</span>` +
  `<span class="ellipsis">navid.me/x/very/lo</span>` +
  `<span class="invisible">ng/path?utm=1</span></a>`;

describe("links", () => {
  it("keeps the whole URL, not the truncated visible text", () => {
    // The failure this exists to prevent: Mastodon truncates the *displayed*
    // text of a long link on purpose, so a naive tag-strip yields
    // "navid.me/x/very/lo" and the real target is gone.
    const out = htmlToMarkdown(`<p>see ${LONG_LINK} ok</p>`);
    expect(out).toContain("https://navid.me/x/very/long/path?utm=1");
    expect(out).not.toContain("ellipsis");
  });

  it("does not emit angle-bracket autolinks", () => {
    // `<https://x>` would be eaten by the tag strip that runs last, which is
    // exactly how the link silently vanished the first time.
    const out = htmlToMarkdown(`<p>a <a href="https://example.com">example.com</a> b</p>`);
    expect(out).toBe("a https://example.com b");
  });

  it("keeps a human label when the text is not the URL", () => {
    const out = htmlToMarkdown(`<p><a href="https://example.com/deep">read this</a></p>`);
    expect(out).toBe("[read this](https://example.com/deep)");
  });
});

describe("mentions", () => {
  it("expands a remote mention to the full handle", () => {
    // The markup carries only "@alice". Without the mention list, a local alice
    // and a remote alice are indistinguishable, and replying hits the wrong one.
    const html = `<span class="h-card"><a href="https://m.example/@alice" class="u-url mention">@<span>alice</span></a></span>`;
    const out = htmlToMarkdown(html, [{ url: "https://m.example/@alice", acct: "alice@m.example" }]);
    expect(out).toBe("@alice@m.example");
  });

  it("falls back to the visible text when the mention list misses", () => {
    const html = `<a href="https://m.example/@bob" class="mention">@<span>bob</span></a>`;
    expect(htmlToMarkdown(html, [])).toBe("@bob");
  });
});

describe("hashtags", () => {
  it("does not treat a hashtag as a mention", () => {
    // Mastodon marks hashtag anchors class="mention hashtag". A mention check
    // that runs first claims it and emits "@#buildinpublic".
    const html = `<a href="https://m.social/tags/buildinpublic" class="mention hashtag" rel="tag">#<span>buildinpublic</span></a>`;
    expect(htmlToMarkdown(html)).toBe("#buildinpublic");
  });
});

describe("structure", () => {
  it("keeps paragraph breaks", () => {
    expect(htmlToMarkdown("<p>one</p><p>two</p>")).toBe("one\n\ntwo");
  });

  it("turns br into a newline", () => {
    expect(htmlToMarkdown("<p>one<br />two</p>")).toBe("one\ntwo");
  });

  it("renders a list", () => {
    expect(htmlToMarkdown("<ul><li>a</li><li>b</li></ul>")).toBe("- a\n- b");
  });
});

describe("entities", () => {
  it("decodes ampersand last, so &amp;lt; survives as &lt;", () => {
    expect(decodeEntities("&amp;lt;")).toBe("&lt;");
  });

  it("decodes numeric and named entities", () => {
    expect(decodeEntities("&#8217;a&quot;b&nbsp;c")).toBe("’a\"b c");
  });
});

describe("preview", () => {
  it("truncates on a word boundary", () => {
    const out = preview(`<p>${"word ".repeat(60)}</p>`, [], 40);
    expect(out.length).toBeLessThanOrEqual(41);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("wor…");
  });

  it("leaves a short status alone", () => {
    expect(preview("<p>short</p>", [], 40)).toBe("short");
  });
});
