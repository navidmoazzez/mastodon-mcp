import { describe, expect, it } from "vitest";
import {
  accountsFromJson,
  normalizeHandle,
  normalizeInstance,
  selectAccount,
  type Config,
} from "../src/config.js";

function config(pairs: [string, string][], preferred: string[] = []): Config {
  return {
    accounts: pairs.map(([handle, instance]) => ({
      handle,
      instance,
      accessToken: "x",
    })),
    preferred,
    readOnly: false,
    allowDestructive: true,
    requestTimeoutMs: 1000,
    minRequestIntervalMs: 0,
    maxRetries: 0,
    userAgent: "test",
  };
}

describe("normalizeInstance", () => {
  it("turns any form of an instance into one canonical origin", () => {
    for (const input of [
      "mastodon.social",
      "https://mastodon.social",
      "https://mastodon.social/",
      "HTTPS://Mastodon.Social/@alice",
    ]) {
      expect(normalizeInstance(input)).toBe("https://mastodon.social");
    }
  });
});

describe("accountsFromJson", () => {
  it("accepts snake_case and camelCase alike", () => {
    const parsed = accountsFromJson(
      JSON.stringify([
        { instance: "mastodon.social", access_token: "t1", handle: "@Alice@mastodon.social" },
        { url: "https://fosstodon.org/", accessToken: "t2" },
      ]),
    );
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ instance: "https://mastodon.social", handle: "alice@mastodon.social" });
    expect(parsed[1]).toMatchObject({ instance: "https://fosstodon.org", accessToken: "t2" });
  });

  it("ignores entries missing a token or an instance", () => {
    expect(accountsFromJson(JSON.stringify([{ instance: "m.social" }, { access_token: "t" }]))).toHaveLength(0);
  });

  it("returns nothing for malformed JSON instead of throwing", () => {
    expect(accountsFromJson("{not json")).toEqual([]);
    expect(accountsFromJson(undefined)).toEqual([]);
  });
});

describe("selectAccount", () => {
  const two = config([
    ["alice@mastodon.social", "https://mastodon.social"],
    ["alice@fosstodon.org", "https://fosstodon.org"],
  ]);

  it("matches a full handle exactly", () => {
    expect(selectAccount(two, "alice@fosstodon.org").instance).toBe("https://fosstodon.org");
  });

  it("matches by instance when the username is ambiguous", () => {
    // The same username on two servers is two different people. This is the
    // whole reason a Mastodon account is a token *plus* an instance.
    expect(selectAccount(two, "fosstodon.org").instance).toBe("https://fosstodon.org");
  });

  it("refuses an ambiguous bare username rather than guessing", () => {
    // Two accounts named alice on two servers are two different people.
    // Silently picking the first is how a post lands on the wrong one.
    expect(() => selectAccount(two, "alice")).toThrow(/No connected Mastodon account matches/);
  });

  it("accepts a bare username when only one account uses it", () => {
    const one = config([["bob@mastodon.social", "https://mastodon.social"]]);
    expect(selectAccount(one, "bob").handle).toBe("bob@mastodon.social");
  });

  it("honours the preference order when no hint is given", () => {
    const c = config(
      [
        ["alice@mastodon.social", "https://mastodon.social"],
        ["brand@fosstodon.org", "https://fosstodon.org"],
      ],
      ["brand@fosstodon.org"],
    );
    expect(selectAccount(c).handle).toBe("brand@fosstodon.org");
  });

  it("explains how to set up an account when there are none", () => {
    expect(() => selectAccount(config([]))).toThrow(/mastodon-mcp login/);
  });
});

describe("normalizeHandle", () => {
  it("strips @ and lowercases", () => {
    expect(normalizeHandle(" @Alice@Mastodon.Social ")).toBe("alice@mastodon.social");
  });
});
