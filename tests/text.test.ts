import { describe, expect, it } from "vitest";
import {
  assertStatusLength,
  countCharacters,
  escapeXml,
  graphemeLength,
  URL_WEIGHT,
} from "../src/content/text.js";

describe("character counting", () => {
  it("counts a URL as 23 characters however long it is", () => {
    // Mastodon shortens links for counting. A naive length check refuses posts
    // the server would have accepted.
    const url = `https://example.com/${"a".repeat(300)}`;
    expect(url.length).toBeGreaterThan(300);
    expect(countCharacters(url)).toBe(URL_WEIGHT);
  });

  it("charges only the local part of a remote mention", () => {
    // "@alice@some.very.long.instance.example" costs "@alice".
    expect(countCharacters("@alice@some.very.long.instance.example")).toBe("@alice".length);
  });

  it("counts a family emoji as one character, not eleven", () => {
    const family = "👨‍👩‍👧‍👦";
    expect(family.length).toBe(11);
    expect(graphemeLength(family)).toBe(1);
    expect(countCharacters(family)).toBe(1);
  });

  it("counts plain text normally", () => {
    expect(countCharacters("hello world")).toBe(11);
  });
});

describe("assertStatusLength", () => {
  it("uses the instance's own limit, not a hardcoded 500", () => {
    // infosec.exchange really does allow 11,000. Hardcoding 500 refuses a legal
    // post on a large part of the fediverse.
    const long = "a".repeat(2000);
    expect(() => assertStatusLength(long, 500, "https://mastodon.social")).toThrow(/allows 500/);
    expect(() => assertStatusLength(long, 11_000, "https://infosec.exchange")).not.toThrow();
  });

  it("names the overage and the instance", () => {
    expect(() => assertStatusLength("a".repeat(501), 500, "https://m.example")).toThrow(
      /501 characters; https:\/\/m\.example allows 500/,
    );
  });

  it("does not refuse a link-heavy status that fits once links are weighted", () => {
    const status = `look ${`https://example.com/${"a".repeat(600)}`} at this`;
    expect(status.length).toBeGreaterThan(500);
    expect(() => assertStatusLength(status, 500, "https://m.example")).not.toThrow();
  });
});

describe("escapeXml", () => {
  it("escapes all five entities", () => {
    expect(escapeXml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&apos;");
  });
});
