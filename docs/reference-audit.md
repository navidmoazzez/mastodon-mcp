# Audit of the two existing Mastodon MCP servers

Read from source on 2026-08-31, not from the READMEs and not from memory. Every
API claim was also checked against a live instance or the published Mastodon
documentation on the same day; those checks are quoted where they matter.

- `the-focus-ai/mastodon-mcp`, TypeScript, 4 tools, 740 lines across `src/`
- `VitexSoftware/mastodon-mcp-server`, Python, 63 tools, 1,211 lines in `server.py`

This file exists so the reasons behind our design decisions do not get lost.
Every claim carries a file and line reference.

## Why this project exists

The two are at opposite ends. One has four tools and cannot do much. The other
covers a lot of endpoints and returns raw JSON for all of them. Neither handles
the three things that actually make Mastodon different from every other network:
per-instance limits, HTML status bodies, and editable posts.

## Their structure

```
the-focus-ai/mastodon-mcp
  src/mastodon_tool.ts    309   4 tools
  src/mastodon_types.ts   191
  src/api.ts              169   7 endpoints
  src/config.ts            48   env vars, plus a 1Password CLI fallback
  src/mcp-server.ts        23

VitexSoftware/mastodon-mcp-server
  mastodon_mcp_server/server.py   1,211   63 tools, via the Mastodon.py library
  mastodon_mcp_server/_mcp.py       196
  debian/                                 a full Debian package, which is genuinely nice
```

## The three things neither one handles

### 1. The character limit is not 500

It is whatever the instance says it is. Verified live on 2026-08-31 by reading
`/api/v2/instance` from three servers:

| Instance | max characters | max media | max poll options |
|---|---:|---:|---:|
| mastodon.social | 500 | 4 | 4 |
| fosstodon.org | 500 | 4 | 4 |
| infosec.exchange | **11,000** | 4 | **10** |

Neither server checks at all. `grep -rn 500 ref-focus/src/` returns nothing, and
`VitexSoftware` passes the text straight to Mastodon.py. Both let the 422 come
back from the instance, which is at least never *wrong*, but it means a status
that was too long is discovered after the round trip, with a server error that
does not name the limit or say how far over it was.

Neither reads the poll ceiling either, so a legal six-option poll on
infosec.exchange cannot be created through the argument schema of one and fails
at the server on the other.

We read `/api/v2/instance` once per instance, cache it, and check against the
real numbers (`src/api/instance.ts`). `get_instance_info` exposes them, so a
model can check before drafting.

There is a second half to this. Mastodon does not count characters the way
`String.length` does: **a URL always counts as 23** no matter how long it is, and
the domain half of a remote mention is free. So a status with a 600-character
tracking URL is legal at 500, and a naive length check refuses it. Neither
reference implements either rule; `src/content/text.ts` implements both.

### 2. A status body is HTML, not text

What the API returns looks like this:

```html
<p>Shipping today <a href="https://navid.me/x/very/long/path?utm=1" rel="nofollow">
  <span class="invisible">https://</span><span class="ellipsis">navid.me/x/very/lo</span
  ><span class="invisible">ng/path?utm=1</span></a> thanks
  <span class="h-card"><a href="https://m.example/@alice" class="u-url mention"
    >@<span>alice</span></a></span></p>
```

`VitexSoftware` returns that verbatim inside its JSON. `the-focus-ai` does the
same. Neither converts it.

Stripping the tags with a regex, which is the obvious fix and is what our own HQ
connector used to do, is worse than it looks. Those `invisible` and `ellipsis`
spans exist because Mastodon deliberately truncates the *displayed* text of a
long link. Strip the tags and the status reads `navid.me/x/very/lo`, and the real
URL is gone. A model that follows it gets a 404. It is the same class of failure
as posting a Bluesky link with no facet, arriving from the opposite direction.

Mentions have the mirror problem: the markup carries only `@alice`, so a local
alice and a remote alice are indistinguishable unless the status's `mentions`
array is consulted. Replying to the wrong one is a real mistake to make.

`src/content/html.ts` converts to markdown, takes every link target from `href`,
and rebuilds mentions into full `@user@instance` handles.

### 3. Posts can be edited, and neither exposes it

Mastodon is the only network in this family where a published post can be edited.
`PUT /api/v1/statuses/:id` exists (verified: 401, not 404), along with
`/source` for the original text and `/history` for the public revision list.

Neither reference server has any of the three. So the only way to fix a typo
through them is delete and repost, which discards every boost, reply and
favourite the post had. That is a real cost paid for a missing endpoint.

We have `edit_status`, `get_status_source` and `get_status_history`.

## the-focus-ai/mastodon-mcp

Four tools: `mastodon_create_toot`, `mastodon_get_timeline`,
`mastodon_get_trending_tags`, `mastodon_search`.

- **Media must be a local file path.** `mastodon_tool.ts` calls `readFile` on
  `params.media_file`, so an MCP server running anywhere but the same machine as
  the caller cannot attach anything. Only one attachment is supported, where
  Mastodon allows four.
- **No polling after upload.** `/api/v2/media` answers 202 for anything larger
  than a small image, and the attachment has no `url` until the instance finishes
  processing. Attaching an unprocessed id makes the status POST fail with a 422
  that does not say why, so video attachments fail depending on how fast the
  instance happens to be that day.
- **The default instance is `floss.social`** (`config.ts:11`), hardcoded, which is
  the author's own server rather than a neutral default.
- **A 1Password CLI fallback** (`config.ts:24`) shells out to
  `op read "op://Personal/Floss.Social Key/notesPlain"`, a vault path specific to
  the author.
- **No character limit at all** on the status field. Not wrong, but it means the
  overage is discovered after the round trip.
- No delete, no reply handling beyond an id, no favourite, no boost, no follow,
  no notifications, no account lookup.

## VitexSoftware/mastodon-mcp-server

63 tools, and genuinely broad: timelines, the graph, lists, follow requests,
mutes, blocks, trends, poll voting. It also has a read-only mode, which most MCP
servers skip and which we kept. The Debian packaging is more care than this kind
of project usually gets.

What it does not have:

- **Structured output.** `fmt()` at `server.py:67` is `json.dumps(data, indent=2, default=str, ensure_ascii=False)`
  and every one of the 63 tools ends in it. A 40-status timeline is tens of
  thousands of tokens of account objects, emoji arrays and media metadata.
- **Pagination past one page.** Mastodon returns no cursor in the body; it returns
  a `Link:` header carrying `max_id`. `grep -c 'Link\|max_id' server.py` returns
  0, so every `limit` is capped at whatever one request returned.
- **Editing, source, history, pin, mute-conversation, translate.**
- **Followed hashtags.** `/api/v1/followed_tags` exists (verified: 401). Following
  a hashtag is how people build a feed on a network with no algorithm, and it is
  absent.
- **Conversations.** `/api/v1/conversations` exists (verified: 401). Direct
  messages are unreachable.
- **Markers.** `/api/v1/markers` exists (verified: 401). There is
  `notifications_clear`, which deletes them permanently, but no way to mark
  notifications *read*, so an agent re-reads the same twenty every run and the
  only alternative is destroying them.
- **Announcements, filters, endorsements, suggestions, domain blocks, reports,
  scheduled statuses.** All exist; none are exposed.
- **Multi-account.** One instance and one token from the environment,
  `MASTODON_INSTANCE` and `MASTODON_ACCESS_TOKEN`, cached in a module-level
  global (`server.py:36-56`). On a federated network, running a personal and a
  project account on two servers means running two copies of the server.
- **Instance limits.** As above.

## What we took

- The read-only mode, and the breadth of endpoint coverage as a target to beat.
- The idea that a Mastodon server should cover moderation properly, not just
  posting and reading.

## Endpoint coverage

Checked against both source trees on 2026-08-31.

| | the-focus-ai | VitexSoftware | ours |
|---|:---:|:---:|:---:|
| Post a status | ✅ | ✅ | ✅ |
| Post a thread as a unit | – | – | ✅ |
| **Edit a status** | – | – | ✅ |
| **Status source and edit history** | – | – | ✅ |
| Delete | – | ✅ | ✅ |
| Media by URL or data URI | ✗ local file only | ✅ | ✅ |
| Wait for media processing | – | – | ✅ |
| Alt text | ✅ | ✅ | ✅ |
| **Media focal point** | – | – | ✅ |
| Polls | – | ✅ | ✅ |
| Vote in a poll | – | ✅ | ✅ |
| Content warnings | – | ✅ | ✅ |
| Native scheduling | partial | – | ✅ |
| **Reschedule and cancel** | – | – | ✅ |
| Favourite, boost, bookmark | – | ✅ | ✅ |
| The inverse of each | – | ✅ | ✅ |
| **Pin and unpin** | – | – | ✅ |
| **Mute a conversation** | – | – | ✅ |
| **Translate a status** | – | – | ✅ |
| Home timeline | ✅ | ✅ | ✅ |
| Local and federated | ✅ | ✅ | ✅ |
| Hashtag timeline | – | ✅ | ✅ |
| **List timeline** | – | – | ✅ |
| **Time-window reads (since_hours)** | – | – | ✅ |
| **Pagination past one page** | – | – | ✅ |
| Search | ✅ | ✅ | ✅ |
| Trends: tags | ✅ | ✅ | ✅ |
| Trends: statuses and links | – | ✅ | ✅ |
| **Followed hashtags, follow/unfollow a tag** | – | – | ✅ |
| Profile directory | – | ✅ | ✅ |
| **Follow suggestions** | – | – | ✅ |
| **Conversations (DMs)** | – | – | ✅ |
| Account lookup | – | ✅ | ✅ |
| **Resolve an unknown remote account** | – | – | ✅ |
| Followers and following | – | ✅ | ✅ |
| Relationships | – | ✅ | ✅ |
| Follow, mute, block, and inverses | – | ✅ | ✅ |
| **Domain blocks** | – | – | ✅ |
| Follow requests | – | ✅ | ✅ |
| **Reports** | – | – | ✅ |
| **Endorsements** | – | – | ✅ |
| Notifications | – | ✅ | ✅ |
| **Read markers** | – | – | ✅ |
| Dismiss and clear | – | ✅ | ✅ |
| Lists | – | ✅ | ✅ |
| **Announcements** | – | – | ✅ |
| Update your profile | – | ✅ | ✅ |
| **Instance limits and rules** | – | partial | ✅ |
| **Per-instance character limit** | – | – | ✅ |
| **URL and mention weighting** | – | – | ✅ |
| **HTML converted to markdown** | – | – | ✅ |
| **Structured output** | – | – | ✅ |
| **Several accounts and instances** | – | – | ✅ |
| **One-command app registration** | – | – | ✅ |
| **Scope checking in doctor** | – | – | ✅ |
| Read-only mode | – | ✅ | ✅ |
| Confirmation on public writes | – | – | ✅ |
| Unit tests | – | – | 50 |

`✗` means present but wrong; `–` means absent.

## Summary

`the-focus-ai/mastodon-mcp` is a four-tool client with a hardcoded instance and a
1Password path from the author's own vault. `VitexSoftware/mastodon-mcp-server`
is a broad, careful wrapper that returns raw JSON, stops at one page of every
listing, and cannot edit a post or mark a notification read.

Neither reads the instance's own limits, converts a status body, or handles more
than one account. Those three, plus editing, are what made a third server worth
writing.
