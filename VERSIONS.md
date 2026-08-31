# Mastodon MCP Versions

| Component | Version | Last Updated |
|-----------|---------|--------------|
| mastodon-mcp | 1.0.0 | 2026-08-31 |

---

## 1.0.0

First release. TypeScript, 76 tools, 50 tests.

Written after reading both existing Mastodon MCP servers in full from source.
The audit is in [docs/reference-audit.md](docs/reference-audit.md) and carries a
file and line reference for every claim.

### The three things Mastodon does differently, that neither reference handles

**The character limit is per instance.** Verified live: mastodon.social allows
500, infosec.exchange allows 11,000 and ten poll options. Neither reference reads
`/api/v2/instance`, so both discover the overage only after a round trip, from a
422 that does not name the limit. This server reads it once per instance and
caches it.

Mastodon also does not count characters the way `String.length` does. A URL
always counts as 23 however long it is, and the domain half of a remote mention
is free. Both rules are implemented.

**A status body is HTML.** Mastodon deliberately truncates the *visible* text of
a long link with `invisible` and `ellipsis` spans, so stripping the tags leaves
`navid.me/x/very/lo` and throws the real URL away. Mentions carry only the local
username, so a local alice and a remote alice are indistinguishable without the
status's mention list. Both references hand the raw HTML over. This one converts
to markdown, takes every link target from `href`, and rebuilds mentions into full
`@user@instance` handles.

**Posts can be edited.** `PUT /api/v1/statuses/:id` exists, along with `/source`
and a public `/history`. Neither reference exposes any of the three, so the only
way to fix a typo through them is delete and repost, discarding every boost,
reply and favourite.

### Setup is one command

`mastodon-mcp login <instance>` registers the application, runs OAuth against a
loopback redirect, verifies the token and stores it. Mastodon has no central
developer portal, so the usual instructions are five manual steps that people get
wrong in the same two places: missing the `write` scope, or copying the client
secret instead of the access token. `POST /api/v1/apps` is unauthenticated
precisely so a client can register itself.

`doctor` then checks the scopes explicitly, because a read-only token passes
every other check and fails on the first post with a 403 that never says why.

### Several accounts, several instances

`MASTODON_ACCOUNTS`, or `login` run more than once. Every tool that acts as
someone takes an `account`. A name that could match two accounts fails and names
both rather than guessing, because two accounts called `alice` on two servers are
two different people.

Neither reference supports more than one account.

### Structured output

Tagged text instead of raw JSON. Measured on five real trending statuses from
mastodon.social: 3,815 characters against 26,439, roughly 950 tokens instead of
6,600. A boost wraps the original rather than flattening it; a content warning is
an attribute rather than hidden text; media with no alt text is flagged.

### Pagination

Mastodon returns no cursor in the body, only a `Link:` header carrying `max_id`.
Neither reference reads it, so every listing stops at one page of 40. Every
listing here follows it.

### Tools

76, against 4 and 63.

New relative to both references: `edit_status`, `get_status_source`,
`get_status_history`, `post_thread`, `pin_status`, `mute_conversation`,
`translate_status`, `vote_poll`, `report`, `get_followed_hashtags`,
`follow_hashtag`, `get_conversations`, `get_read_position`, `mark_read`,
`get_announcements`, `get_endorsements`, `block_domain`, `get_list_timeline`,
`reschedule_status`, `get_instance_info`, `get_suggested_follows`,
`list_accounts`, `whoami`.

### Safety

`post_status`, `post_thread`, `edit_status`, `delete_status`, `update_profile`,
`vote_poll`, `report`, `block_account`, `block_domain`, `clear_notifications` and
`delete_list` need `confirm: true`. `MASTODON_READ_ONLY=1` removes every write
from the tool list. `MASTODON_AUDIT_LOG` records every attempted write, mode 0600.

### Reliability

Per-instance limits cached. 429 and 5xx retried with jittered backoff honouring
Mastodon's real `X-RateLimit-Reset`. Per-request timeout. A minimum interval
between requests so a paginating tool stays polite. Media uploads polled until
the instance finishes processing, because attaching an unprocessed id fails with
a 422 that does not explain itself.
