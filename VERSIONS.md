# Mastodon MCP Versions

| Component | Version | Last Updated |
|-----------|---------|--------------|
| mastodon-mcp | 1.0.0 | 2026-08-31 |

---

## 1.0.0

First release. TypeScript, 76 tools, 50 tests.

### Three things Mastodon does differently

**The character limit is per instance.** Verified live: mastodon.social allows
500, infosec.exchange allows 11,000 and ten poll options. `/api/v2/instance` is
read once per instance and cached, so a legal 2,000-character post is accepted
where it is legal and refused with the actual number where it is not.

Mastodon also does not count characters the way `String.length` does. A URL
always counts as 23 however long it is, and the domain half of a remote mention
is free. Both rules are implemented, so a link-heavy status is not refused for
being over a limit it is not over.

**A status body is HTML.** Mastodon deliberately truncates the visible text of a
long link with `invisible` and `ellipsis` spans, so stripping the tags leaves
`navid.me/x/very/lo` and throws the real URL away. Mentions carry only the local
username, so a local alice and a remote alice are indistinguishable without the
status's mention list, and replying to the wrong one is a real mistake to make.
Converted to markdown here, with every link target taken from `href` and mentions
rebuilt into full `@user@instance` handles.

**Posts can be edited.** `PUT /api/v1/statuses/:id`, plus `/source` for the
original text and a public `/history`. The post keeps its boosts, replies and
favourites, so `edit_status` is almost always better than delete-and-repost.

### Setup is one command

`mastodon-mcp login <instance>` registers the application, runs OAuth against a
loopback redirect, verifies the token and stores it mode 0600. Mastodon has no
central developer portal: every instance is its own OAuth provider, and
`POST /api/v1/apps` is unauthenticated precisely so a client can register itself.

`doctor` then checks the granted scopes explicitly, because a read-only token
passes every other check and fails on the first post with a 403 that never
mentions scopes.

### Several accounts, several instances

An account is a token plus an instance, so the same username on two servers is
two different people. `MASTODON_ACCOUNTS`, or `login` run more than once. Every
tool that acts as someone takes an `account`. A name that could match two
accounts fails and names both rather than guessing.

### Output

Tagged text instead of raw JSON. Measured on five real trending statuses from
mastodon.social: 3,815 characters against 26,439, roughly 950 tokens instead of
6,600. A boost wraps the original rather than flattening it, a content warning is
an attribute rather than hidden text, media with no alt text is flagged, and a
thread's reply tree is rebuilt from `in_reply_to_id` rather than handed over as
two flat arrays.

### Pagination

Mastodon returns no cursor in the body, only a `Link:` header carrying `max_id`.
Every listing follows it, so a `limit` of 200 returns 200 rather than one page
of 40.

### Tools

76, across posting, editing, five timelines, hashtags, lists, conversations,
notifications, the graph and moderation. Every action has its inverse.

### Safety

`post_status`, `post_thread`, `edit_status`, `delete_status`, `update_profile`,
`vote_poll`, `report`, `block_account`, `block_domain`, `clear_notifications` and
`delete_list` need `confirm: true`. A poll vote cannot be withdrawn; a report
reaches human moderators. `MASTODON_READ_ONLY=1` leaves 39 read tools and hides
every write. `MASTODON_AUDIT_LOG` records every attempted write, mode 0600.

### Reliability

Per-instance limits cached. 429 and 5xx retried with jittered backoff honouring
Mastodon's real `X-RateLimit-Reset`, which is an ISO timestamp rather than a
number of seconds. Per-request timeout, and a minimum interval between requests.
Media uploads polled until the instance finishes processing, because attaching an
unprocessed id fails with a 422 that does not explain itself.
