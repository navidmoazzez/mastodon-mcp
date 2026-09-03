/**
 * The CLI adapter.
 *
 * What matters here is that the shell surface is derived from the tool specs
 * rather than described a second time, so the tests that count are the ones
 * asserting parity with ALL_TOOLS and the ones covering the argv shapes a
 * person actually types.
 */

import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EXIT, exitCodeFor, flagsFor, parseArgs, isCliCommand } from "../src/cli.js";
import { ALL_TOOLS } from "../src/tools/index.js";

describe("flagsFor", () => {
  it("derives a flag per schema key, kebab-cased", () => {
    const flags = flagsFor({ reply_to: z.string().optional() });
    expect(flags[0]).toMatchObject({ key: "reply_to", flag: "--reply-to", kind: "string" });
  });

  it("reads required from the absence of .optional()", () => {
    const flags = flagsFor({ text: z.string(), account: z.string().optional() });
    expect(flags.find((f) => f.key === "text")?.required).toBe(true);
    expect(flags.find((f) => f.key === "account")?.required).toBe(false);
  });

  it("carries .describe() through as help", () => {
    const flags = flagsFor({ text: z.string().describe("The post body.") });
    expect(flags[0]?.help).toBe("The post body.");
  });

  it("finds the description whichever side of .optional() it was chained", () => {
    const outer = flagsFor({ a: z.string().optional().describe("outer") });
    const inner = flagsFor({ b: z.string().describe("inner").optional() });
    expect(outer[0]?.help).toBe("outer");
    expect(inner[0]?.help).toBe("inner");
  });

  it("exposes an enum's values as choices", () => {
    const flags = flagsFor({ visibility: z.enum(["public", "unlisted", "private", "direct"]).optional() });
    expect(flags[0]).toMatchObject({
      kind: "enum",
      choices: ["public", "unlisted", "private", "direct"],
    });
  });

  it("marks a scalar array repeatable and an object array json", () => {
    const flags = flagsFor({
      langs: z.array(z.string()).optional(),
      images: z.array(z.object({ url: z.string() })).optional(),
    });
    expect(flags.find((f) => f.key === "langs")).toMatchObject({ kind: "string", repeatable: true });
    expect(flags.find((f) => f.key === "images")).toMatchObject({ kind: "json", repeatable: true });
  });

  /**
   * `--types mention` used to be rejected in favour of `--types '"mention"'`,
   * because an enum inside an array fell through to the JSON branch. An enum
   * value is a word you type, so it belongs with the scalars.
   */
  it("treats an array of enums as a repeatable scalar, not JSON", () => {
    const flags = flagsFor({ types: z.array(z.enum(["mention", "favourite"])).optional() });
    expect(flags[0]).toMatchObject({ kind: "string", repeatable: true });
    expect(parseArgs(["--types", "mention"], flags)).toEqual({ types: ["mention"] });
  });
});

describe("exitCodeFor", () => {
  /**
   * "No Mastodon account configured..." names a token, so matching auth first
   * sent someone who had configured nothing looking for an expired credential.
   */
  it("calls an unconfigured server config, not auth", () => {
    const message =
      "No Mastodon account configured. Run `mastodon-mcp login <your-instance>` to register an app and sign in, or set MASTODON_URL and MASTODON_ACCESS_TOKEN.";
    expect(exitCodeFor(new Error(message))).toBe(EXIT.config);
  });

  it("still calls a real 401 auth", () => {
    expect(exitCodeFor({ status: 401, message: "the instance rejected the access token" })).toBe(
      EXIT.auth,
    );
  });

  /** A write stopped for want of --confirm is the caller's to fix, not a fault. */
  it("calls a refused write usage", () => {
    expect(
      exitCodeFor(new Error("post_status is public or irreversible, so it will not run without --confirm.")),
    ).toBe(EXIT.usage);
    expect(
      exitCodeFor(new Error("post_status is unavailable: this server is running with MASTODON_READ_ONLY=1.")),
    ).toBe(EXIT.usage);
  });

  it("keeps rate limiting and not-found distinct", () => {
    expect(exitCodeFor({ status: 429 })).toBe(EXIT.rateLimited);
    expect(exitCodeFor({ status: 404 })).toBe(EXIT.notFound);
    expect(exitCodeFor({ status: 503 })).toBe(EXIT.api);
  });
});

describe("parseArgs", () => {
  const flags = flagsFor({
    text: z.string(),
    limit: z.number().optional(),
    confirm: z.boolean().optional(),
    langs: z.array(z.string()).optional(),
    link: z.object({ uri: z.string() }).optional(),
    visibility: z.enum(["public", "unlisted", "private", "direct"]).optional(),
  });

  it("accepts --flag value and --flag=value alike", () => {
    expect(parseArgs(["--text", "hi"], flags)).toEqual({ text: "hi" });
    expect(parseArgs(["--text=hi"], flags)).toEqual({ text: "hi" });
  });

  it("accepts the underscore spelling of a flag", () => {
    expect(parseArgs(["--visibility", "unlisted"], flags)).toEqual({ visibility: "unlisted" });
  });

  it("treats a boolean as a bare switch", () => {
    expect(parseArgs(["--text", "hi", "--confirm"], flags)).toEqual({ text: "hi", confirm: true });
    expect(parseArgs(["--confirm=false"], flags)).toEqual({ confirm: false });
  });

  it("coerces numbers, and refuses ones that are not", () => {
    expect(parseArgs(["--limit", "25"], flags)).toEqual({ limit: 25 });
    expect(() => parseArgs(["--limit", "many"], flags)).toThrow(/expects a number/);
  });

  it("parses a json flag, and refuses malformed json", () => {
    expect(parseArgs(['--link={"uri":"https://x.com"}'], flags)).toEqual({
      link: { uri: "https://x.com" },
    });
    expect(() => parseArgs(["--link", "{oops"], flags)).toThrow(/expects JSON/);
  });

  it("collects a repeatable flag into an array", () => {
    expect(parseArgs(["--langs", "en", "--langs", "sv"], flags)).toEqual({ langs: ["en", "sv"] });
  });

  it("checks an enum against its choices", () => {
    expect(() => parseArgs(["--visibility", "friends"], flags)).toThrow(/expects one of/);
  });

  it("fills the first required flag from a bare argument", () => {
    expect(parseArgs(["hello"], flags)).toEqual({ text: "hello" });
  });

  it("wraps a bare argument when the required flag is repeatable", () => {
    const repeatable = flagsFor({ media_ids: z.array(z.string()) });
    expect(parseArgs(["109252"], repeatable)).toEqual({ media_ids: ["109252"] });
  });

  it("refuses an unknown option rather than dropping it", () => {
    expect(() => parseArgs(["--nope", "x"], flags)).toThrow(/Unknown option/);
  });

  it("refuses a second bare argument", () => {
    expect(() => parseArgs(["one", "two"], flags)).toThrow(/Unexpected argument/);
  });
});

describe("parity with the MCP surface", () => {
  it("routes every tool name, in both spellings", () => {
    for (const tool of ALL_TOOLS) {
      expect(isCliCommand([tool.name])).toBe(true);
      expect(isCliCommand([tool.name.replace(/_/g, "-")])).toBe(true);
    }
  });

  it("builds flags for every tool without throwing", () => {
    for (const tool of ALL_TOOLS) {
      expect(() => flagsFor(tool.schema)).not.toThrow();
    }
  });

  it("gives every schema key a flag", () => {
    for (const tool of ALL_TOOLS) {
      expect(flagsFor(tool.schema)).toHaveLength(Object.keys(tool.schema).length);
    }
  });

  it("leaves the server's own flags alone", () => {
    expect(isCliCommand(["--http"])).toBe(false);
    expect(isCliCommand(["--version"])).toBe(false);
    expect(isCliCommand([])).toBe(false);
  });
});

describe("documentation stays in step with the code", () => {
  const read = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf-8");
  const names = (text: string): Set<string> => new Set(text.match(/MASTODON_[A-Z_]+/g) ?? []);

  /**
   * Four variables shipped undocumented and seven never reached `--help`, which
   * is the kind of drift nobody notices because both sides look complete on
   * their own.
   */
  it("documents every environment variable the code reads", () => {
    const used = names(["config.ts", "transport/http.ts"].map((f) => read(`../src/${f}`)).join("\n"));
    const documented = names(read("../README.md"));
    expect([...used].filter((v) => !documented.has(v))).toEqual([]);
  });

  it("lists every environment variable in --help", () => {
    const used = names(["config.ts", "transport/http.ts"].map((f) => read(`../src/${f}`)).join("\n"));
    const helped = names(read("../src/index.ts"));
    // The help groups the three HTTP ones as `MASTODON_HTTP_PORT / _HOST / _TOKEN`,
    // so only the two abbreviated halves fail a literal match.
    const shorthand = new Set(["MASTODON_HTTP_HOST", "MASTODON_HTTP_TOKEN"]);
    expect([...used].filter((v) => !helped.has(v) && !shorthand.has(v))).toEqual([]);
  });

  /**
   * Two in-page links pointed at headings that had been renamed, including the
   * one row routing a shell user to the CLI. The ship checklist's link pass only
   * greps http, so a dead `#anchor` is the kind that ships quietly.
   */
  it.each(["../README.md", "../INSTALL.md"])("has no dead in-page anchors in %s", (file) => {
    if (!existsSync(new URL(file, import.meta.url))) return; // repo may ship one doc
    const md = read(file);
    const slugs = new Set<string>();
    for (const [, heading] of md.matchAll(/^#{2,4} (.+)$/gm)) {
      const stripped = (heading as string).toLowerCase().replace(/[^\w\s-]/g, "");
      // GitHub keeps the trailing hyphen when a heading ends in an emoji.
      slugs.add(stripped.trim().replace(/\s+/g, "-"));
      slugs.add(stripped.replace(/\s+/g, "-"));
    }
    const dead = [...md.matchAll(/\[[^\]]+\]\(#([^)]+)\)/g)]
      .map((m) => m[1] as string)
      .filter((a) => !slugs.has(a));
    expect(dead).toEqual([]);
  });
});
