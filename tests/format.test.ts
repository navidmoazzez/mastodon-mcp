import { describe, expect, it } from "vitest";
import { renderContext, renderStatus, renderStatuses } from "../src/format/statuses.js";

const account = { acct: "alice@m.example", display_name: 'Alice "A" Smith', id: "1" };

function status(overrides: Record<string, any> = {}) {
  return {
    id: "100",
    url: "https://m.example/@alice/100",
    account,
    created_at: "2026-01-02T03:04:05.678Z",
    visibility: "public",
    content: "<p>hello</p>",
    favourites_count: 3,
    reblogs_count: 1,
    replies_count: 2,
    mentions: [],
    media_attachments: [],
    ...overrides,
  };
}

describe("escaping", () => {
  it("escapes quotes in a display name", () => {
    expect(renderStatus(status())).toContain('author_name="Alice &quot;A&quot; Smith"');
  });

  it("escapes markup in the body", () => {
    const out = renderStatus(status({ content: "<p>&lt;script&gt;&amp;</p>" }));
    expect(out).toContain("<content>&lt;script&gt;&amp;</content>");
  });
});

describe("timestamps", () => {
  it("renders ISO-8601 UTC, so two can be compared", () => {
    expect(renderStatus(status())).toContain('posted_at="2026-01-02T03:04:05.678Z"');
  });

  it("passes an unparseable timestamp through rather than printing Invalid Date", () => {
    const out = renderStatus(status({ created_at: "sometime" }));
    expect(out).toContain('posted_at="sometime"');
    expect(out).not.toContain("Invalid Date");
  });
});

describe("boosts", () => {
  it("wraps the original rather than flattening it", () => {
    // Flattening attributes someone else's words to the booster.
    const out = renderStatuses([
      {
        id: "200",
        account: { acct: "bob@other.social", display_name: "Bob" },
        created_at: "2026-01-03T00:00:00.000Z",
        reblog: status(),
      },
    ]);
    expect(out).toContain('<boost by="bob@other.social"');
    expect(out).toContain('author="alice@m.example"');
    // The inner status sits inside the boost wrapper, not beside it.
    expect(out.indexOf("<boost")).toBeLessThan(out.indexOf("<status id="));
    expect(out.indexOf("</boost>")).toBeGreaterThan(out.indexOf("</status>"));
  });
});

describe("attributes a model needs", () => {
  it("surfaces a content warning without hiding the body", () => {
    const out = renderStatus(status({ spoiler_text: "politics", sensitive: true }));
    expect(out).toContain('content_warning="politics"');
    expect(out).toContain('sensitive="true"');
    expect(out).toContain("<content>hello</content>");
  });

  it("flags media with no alt text", () => {
    const out = renderStatus(
      status({ media_attachments: [{ type: "image", url: "https://x/1.png", description: "" }] }),
    );
    expect(out).toContain('missing_alt="true"');
  });

  it("does not flag media that has alt text", () => {
    const out = renderStatus(
      status({ media_attachments: [{ type: "image", url: "https://x/1.png", description: "a chart" }] }),
    );
    expect(out).toContain('alt="a chart"');
    expect(out).not.toContain("missing_alt");
  });

  it("marks an edited status", () => {
    expect(renderStatus(status({ edited_at: "2026-01-04T00:00:00.000Z" }))).toContain(
      'edited_at="2026-01-04T00:00:00.000Z"',
    );
  });

  it("shows your own interaction state", () => {
    const out = renderStatus(status({ favourited: true, bookmarked: true }));
    expect(out).toContain('you_favourited="true"');
    expect(out).toContain('you_bookmarked="true"');
    expect(out).not.toContain("you_boosted");
  });

  it("renders a poll with its options and indexes", () => {
    const out = renderStatus(
      status({
        poll: {
          id: "9",
          expires_at: "2026-01-05T00:00:00.000Z",
          expired: false,
          multiple: false,
          votes_count: 12,
          options: [
            { title: "yes", votes_count: 8 },
            { title: "no", votes_count: 4 },
          ],
        },
      }),
    );
    expect(out).toContain('<poll id="9"');
    expect(out).toContain('<option index="0" votes="8">yes</option>');
    expect(out).toContain('<option index="1" votes="4">no</option>');
  });
});

describe("threads", () => {
  it("rebuilds the reply tree from in_reply_to_id", () => {
    // Mastodon returns two flat arrays and leaves the structure to the caller.
    const root = status({ id: "1", content: "<p>root</p>" });
    const context = {
      ancestors: [],
      descendants: [
        status({ id: "2", content: "<p>child</p>", in_reply_to_id: "1" }),
        status({ id: "3", content: "<p>grandchild</p>", in_reply_to_id: "2" }),
      ],
    };
    const out = renderContext(root, context);
    expect(out).toContain('requested="true"');
    expect(out.indexOf("root")).toBeLessThan(out.indexOf("child"));
    expect(out.indexOf("child")).toBeLessThan(out.indexOf("grandchild"));
    // The grandchild is nested inside the child, not a sibling of it.
    const childIndex = out.indexOf('id="2"');
    const repliesAfterChild = out.indexOf("<replies>", childIndex);
    expect(repliesAfterChild).toBeGreaterThan(-1);
    expect(repliesAfterChild).toBeLessThan(out.indexOf('id="3"'));
  });

  it("puts ancestors above the requested status", () => {
    const out = renderContext(status({ id: "2", content: "<p>reply</p>", in_reply_to_id: "1" }), {
      ancestors: [status({ id: "1", content: "<p>original</p>" })],
      descendants: [],
    });
    expect(out.indexOf("original")).toBeLessThan(out.indexOf("reply"));
  });

  it("keeps a reply whose parent is missing rather than dropping it", () => {
    const out = renderContext(status({ id: "1" }), {
      ancestors: [],
      descendants: [status({ id: "9", content: "<p>orphan</p>", in_reply_to_id: "deleted" })],
    });
    expect(out).toContain("<detached");
    expect(out).toContain("orphan");
  });
});

describe("listings", () => {
  it("carries the pagination id on the root element", () => {
    expect(renderStatuses([], { nextMaxId: "abc" })).toContain('next_max_id="abc"');
  });
});
