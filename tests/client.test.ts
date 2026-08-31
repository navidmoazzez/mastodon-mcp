import { describe, expect, it } from "vitest";
import { parseLinkHeader } from "../src/api/client.js";

describe("parseLinkHeader", () => {
  it("pulls max_id and min_id out of a real Link header", () => {
    // Mastodon has no cursor in the body. This header is the only way to page;
    // miss it and every listing silently stops at 40 results.
    const header =
      '<https://m.social/api/v1/timelines/home?max_id=109>; rel="next", ' +
      '<https://m.social/api/v1/timelines/home?min_id=113>; rel="prev"';
    expect(parseLinkHeader(header)).toEqual({ next: "109", prev: "113" });
  });

  it("handles a next link on its own", () => {
    expect(parseLinkHeader('<https://m.social/api/v1/notifications?max_id=7>; rel="next"')).toEqual({
      next: "7",
    });
  });

  it("returns nothing for a missing or malformed header", () => {
    expect(parseLinkHeader(null)).toEqual({});
    expect(parseLinkHeader("garbage")).toEqual({});
    expect(parseLinkHeader('<not a url>; rel="next"')).toEqual({});
  });
});
