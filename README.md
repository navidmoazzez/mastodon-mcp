# Mastodon MCP

Give any AI agent full control of your Mastodon account. Post, edit, run threads, read five different timelines, follow hashtags, manage lists, and work your notifications, from Claude, Cursor, or any MCP client.

76 tools. Setup is one command: Mastodon has no developer portal, so this registers its own application on your instance and signs you in.

Built by [Navid Moazzez](https://navid.me).

```
You: anything in my mentions that actually needs an answer?

Claude: 14 notifications since you last read. 4 mentions, the rest are boosts.

  Needs you:
  1. @sam@hachyderm.io asked which instance you'd pick for a small team.
     Real question, 2 replies already, both wrong about storage costs.
  2. @lena@fosstodon.org found the typo in Tuesday's post. It's in the
     third paragraph. You can fix it in place, the post has 41 boosts.

  Doesn't:
  3. Two "great post!" replies.

  Want me to draft the reply to Sam, or fix the typo first?
```

## Contents

| | Section | |
|---|---|---|
| 1 | [What you can ask it](#1-what-you-can-ask-it) | Real prompts, not features |
| 2 | [Install](#2-install) | Every client, copy and paste |
| 3 | [Connect your account](#3-connect-your-account) | One command, and what it does |
| 4 | [Several accounts](#4-several-accounts) | Personal and project, different servers |
| 5 | [Tools](#5-tools) | All 76, with arguments |
| 6 | [Writing safely](#6-writing-safely) | Why posting asks twice |
| 7 | [Writing statuses](#7-writing-statuses) | Limits, media, warnings, editing |
| 8 | [Reading statuses](#8-reading-statuses) | The output format, and why |
| 9 | [What makes Mastodon different](#9-what-makes-mastodon-different) | Federation, in practice |
| 10 | [How it works](#10-how-it-works) | Architecture |
| 11 | [Your data](#11-your-data) | What is stored and where |
| 12 | [Risks](#12-risks) | Read this before you install |
| 13 | [Troubleshooting](#13-troubleshooting) | When something breaks |
| 14 | [Build from source](#14-build-from-source) | Run it from a checkout |

---

## 1. What you can ask it

- Post this, and put a content warning on it.
- There's a typo in Tuesday's post. Fix it without losing the boosts.
- What did my timeline talk about in the last 12 hours?
- Anything in my mentions that actually needs an answer?
- Find people posting about local-first software and tell me who's worth following.
- Follow the hashtags that keep showing up in my favourites.
- Read the replies to that post and tell me which ones are arguing in good faith.
- Make a list called "rust people" and put everyone I follow who posts about Rust on it.
- What's trending on my instance, as opposed to on mastodon.social?
- Turn these notes into a thread. My instance allows 11,000 characters, so check before you split it.

The second one is the point. Mastodon lets you edit a published post and keeps a public revision history, so the post keeps its boosts, replies and favourites. Deleting and reposting throws all of that away, so `edit_status` is almost always the right move.

---

## 2. Install

Node 20 or newer. Nothing else.

> Not released to npm yet. The `npx` commands below work once `v1.0.0` is
> published. Until then, install from source with
> [section 14](#14-build-from-source) and point your client at
> `node /path/to/mastodon-mcp/dist/index.js`.

### Claude Code

```bash
npx -y @thenavidm/mastodon-mcp login mastodon.social   # or your own instance
claude mcp add mastodon -- npx -y @thenavidm/mastodon-mcp
```

The `login` step stores the token, so the MCP entry needs no environment variables.

### Claude Desktop

**1. Open the config file.**

In Claude Desktop, go to **Settings**, then **Developer**, then click **Edit Config**. That reveals `claude_desktop_config.json` in your file manager. Open it in any text editor.

If you would rather go straight there:

| | |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

On macOS you can open it from a terminal with:

```bash
open -e ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

**2. Add the server.**

If the file is empty or does not exist, paste this whole thing in:

```json
{
  "mcpServers": {
    "mastodon": {
      "command": "npx",
      "args": ["-y", "@thenavidm/mastodon-mcp"]
    }
  }
}
```

If you already have other servers, add only the `"mastodon": {{ ... }}` part inside your existing `"mcpServers"`, and put a comma after the entry before it. The file has to stay valid JSON. A single missing comma or a trailing one stops every server from loading, not just this one.

Run `npx -y @thenavidm/mastodon-mcp login <your-instance>` once before this, so the server has a session to use. [Section 3](#3-connect-your-account) covers it.

**3. Restart properly.**

Quit Claude Desktop completely and reopen it. On macOS closing the window is not enough, use **Cmd+Q**. On Windows quit it from the system tray. Claude only reads that file at startup.

**4. Check it worked.**

Look for the tools icon in the message box and click it. You should see `mastodon` with its tools listed. Then ask it something from [section 1](#1-what-you-can-ask-it).

If nothing appears, Claude Desktop's own log is the fastest way in:

| | |
|---|---|
| macOS | `~/Library/Logs/Claude/mcp-server-mastodon.log` |
| Windows | `%APPDATA%\Claude\logs\mcp-server-mastodon.log` |

```bash
tail -n 50 ~/Library/Logs/Claude/mcp-server-mastodon.log
```

Two things account for most failures. Node is not installed, or not on the PATH that Claude Desktop sees, in which case use the full path to `node` as the `command`. Or the JSON is malformed, which you can check by pasting the file into any JSON validator.

### Cursor

Create `~/.cursor/mcp.json` for every project, or `.cursor/mcp.json` inside a single project. Use the same JSON as Claude Desktop. Then reload the window, or open **Settings**, **MCP**, and toggle the server.

### Windsurf

`~/.codeium/windsurf/mcp_config.json`, same JSON, then reload.

### VS Code

`.vscode/mcp.json` in a project, or run **MCP: Add Server** from the command palette.

### Everything else

Zed, Cline, Continue and anything else that speaks MCP over stdio all work. They each keep their config somewhere different, but they all want the same things: the `command`, the `args`, and the `env`.

### Docker

The store lives in `/data`, so mount a volume or pass the token directly:

```bash
docker build -t mastodon-mcp .
docker run --rm -i \
  -e MASTODON_URL=https://mastodon.social \
  -e MASTODON_ACCESS_TOKEN=… \
  mastodon-mcp
```

### Self-hosting over HTTP

```bash
MASTODON_HTTP_PORT=8788 \
MASTODON_HTTP_TOKEN=$(openssl rand -hex 32) \
mastodon-mcp --http
```

Binds `127.0.0.1` by default. An access token reaches your whole account, so put it behind a reverse proxy with TLS before you change `MASTODON_HTTP_HOST`, and set `MASTODON_HTTP_TOKEN` so the endpoint is not open. `GET /health` returns the tool and account count without authentication.

### Check it worked

```bash
mastodon-mcp doctor
```

It checks the instance, the token, and **the token's scopes**, which is the failure people actually hit: a read-only token passes every other check and then fails on the first post with a 403 that never mentions scopes.

---

## 3. Connect your account

```bash
mastodon-mcp login mastodon.social
```

That is the whole setup. It opens your browser, you approve, and it stores the token.

### Have an agent do it

Paste this into Claude Code, Cursor, or any agent with terminal access:

```
Set up the Mastodon MCP server for me.

1. Ask me which instance my account is on, e.g. mastodon.social. Do not guess.
2. Run: npx -y @thenavidm/mastodon-mcp login <instance>
   It opens my browser and waits. Tell me to approve the request there, and
   wait for it to finish. It asks for read, write and follow; that is correct.
   If there is no browser available, re-run it with --oob and I will paste the
   code back to you.
3. Register the server with my MCP client. For Claude Code that is:
     claude mcp add mastodon -- npx -y @thenavidm/mastodon-mcp
   No environment variables: step 2 already stored the token.
4. Run: npx -y @thenavidm/mastodon-mcp doctor
   Show me the output. Pay attention to the line about scopes: if it says the
   account cannot post, the token is read-only and step 2 needs redoing.
5. Tell me to restart the client. Do not post anything.

If I have more than one account, repeat step 2 per account and per instance.
```

It stops and waits at step 2, because only you can approve in the browser.

### Why this is one command and not five

Mastodon has no central developer portal. Every instance is its own OAuth provider, so before you can get a token you have to register an application **on that instance**. The usual instructions are "go to Preferences, Development, New application, tick these scopes, save, copy the access token", and people get it wrong in the same two places every time: they miss the `write` scope, or they copy the client secret instead of the access token.

`POST /api/v1/apps` is unauthenticated, precisely so that a client can register itself. So `login` does all of it:

1. registers `mastodon-mcp` as an application on your instance
2. opens `/oauth/authorize` in your browser, asking for `read write follow`
3. catches the redirect on `127.0.0.1`
4. exchanges the code for a token
5. verifies the token and works out your handle
6. writes it to `~/.mastodon-mcp/accounts.json`, mode 0600

`push` is deliberately not requested. Nothing here subscribes to push notifications, and asking for a permission you never use makes the token more dangerous than the tool.

### Check it worked

```bash
mastodon-mcp doctor
```

It reports your instance's real limits, verifies the token, and checks **the granted scopes**. That last one is the failure everything else hides: a read-only token passes every other check and then fails on the first post with a 403 that never mentions scopes.

### If you have no browser

```bash
mastodon-mcp login mastodon.social --oob
```

Prints the URL, you paste the code back.

### If you already made an app by hand

```bash
mastodon-mcp login mastodon.social --token=YOUR_ACCESS_TOKEN
```

Or skip the store entirely:

```bash
export MASTODON_URL=https://mastodon.social
export MASTODON_ACCESS_TOKEN=…
```

If you make the app yourself, tick **read**, **write** and **follow**, and copy **"Your access token"**, not the client secret.

### Revoking

`https://your-instance/oauth/authorized_applications`. Removing it there kills the token immediately. `mastodon-mcp logout <handle>` only forgets it locally.

---

## 4. Several accounts

Mastodon is federated, so an account is a **token plus an instance**. The same username on two servers is two different people. Running a personal account and a project account, often on different instances, is the normal case here rather than the exotic one.

Run `login` once per account:

```bash
mastodon-mcp login mastodon.social     # you@mastodon.social
mastodon-mcp login fosstodon.org       # project@fosstodon.org
```

Both are stored. `list_accounts` shows them:

```
you@mastodon.social      https://mastodon.social
project@fosstodon.org    https://fosstodon.org
```

Every tool that acts as someone takes an optional `account`:

```
post_status(status: "…", account: "project@fosstodon.org", confirm: true)
```

### How a name is matched

In order:

1. **Full handle**: `project@fosstodon.org`. Always unambiguous, always prefer this.
2. **Instance**: `fosstodon.org`, when only one account lives there.
3. **Bare username**: `project`, when only one account uses it.
4. **Prefix**, when exactly one account matches.

If two accounts could match, the call **fails and names both** rather than guessing. Two accounts called `alice` on two servers are two different people, and silently picking the first is how a post lands on the wrong one.

### Which account acts by default

The first one configured, unless you say otherwise:

```bash
export MASTODON_DEFAULT_ACCOUNT=you@mastodon.social
```

### Or configure them without the store

```bash
export MASTODON_ACCOUNTS='[
  {"instance":"https://mastodon.social","access_token":"…","handle":"you@mastodon.social"},
  {"instance":"https://fosstodon.org","access_token":"…","handle":"project@fosstodon.org"}
]'
```

`handle` is optional; it is only used for matching, and `whoami` will tell you the real one.

---

## 5. Tools

76 tools. Every one that acts as you takes an optional `account`; every listing takes `limit` and pages automatically past Mastodon's 40-per-request ceiling.

### Accounts and instance

| Tool | What it does |
|---|---|
| `list_accounts` | Every connected account and its instance |
| `whoami` | Authenticate and return the live profile |
| `get_instance_info` | Character limit, media and poll ceilings, version, server rules |
| `update_profile` | Display name, bio, the four metadata fields |

### Posting

| Tool | Arguments |
|---|---|
| `post_status` | `status`, `media[]`, `in_reply_to_id`, `spoiler_text`, `visibility`, `sensitive`, `language`, `scheduled_at`, `poll_options[]`, `poll_expires_in`, `poll_multiple`, `confirm` |
| `post_thread` | `parts[]`, `media[]`, `in_reply_to_id`, `spoiler_text`, `visibility`, `language`, `confirm` |
| `edit_status` | `id`, `status`, `spoiler_text`, `sensitive`, `language`, `media_ids[]`, `confirm` |
| `get_status_source` | `id` |
| `get_status_history` | `id` |
| `delete_status` | `id`, `confirm` |
| `get_status` | `id` |
| `get_thread` | `id` |
| `list_scheduled_statuses` | none |
| `reschedule_status` | `id`, `scheduled_at` |
| `cancel_scheduled_status` | `id` |
| `get_favourites` / `get_bookmarks` | `limit` |

### Engaging

| Tool | Arguments |
|---|---|
| `favourite_status` / `unfavourite_status` | `id` |
| `boost_status` / `unboost_status` | `id` |
| `bookmark_status` / `unbookmark_status` | `id` |
| `pin_status` / `unpin_status` | `id` |
| `mute_conversation` / `unmute_conversation` | `id` |
| `vote_poll` | `poll_id`, `choices[]`, `confirm` |
| `translate_status` | `id`, `lang` |
| `get_favourited_by` / `get_boosted_by` | `id`, `limit` |
| `report` | `account_id`, `status_ids[]`, `comment`, `category`, `rule_ids[]`, `forward`, `confirm` |

Every action has its inverse. Mastodon has no native quote post: to comment on something, post a status containing its URL.

### Timelines

| Tool | Arguments |
|---|---|
| `get_home_timeline` | `limit`, `since_hours`, `max_id` |
| `get_local_timeline` | `limit`, `since_hours`, `max_id` |
| `get_federated_timeline` | `remote_only`, `only_media`, `limit`, `since_hours` |
| `get_hashtag_timeline` | `hashtag`, `local_only`, `any[]`, `all[]`, `none[]`, `limit` |
| `get_list_timeline` | `list_id`, `limit`, `since_hours` |
| `get_account_statuses` | `acct`, `exclude_replies`, `exclude_reblogs`, `only_media`, `tagged`, `pinned`, `limit`, `since_hours` |

`since_hours` reads a time window instead of a count: `since_hours: 12` pages until it reaches twelve hours back.

### Discovering

| Tool | Arguments |
|---|---|
| `search` | `q`, `type`, `resolve`, `following_only`, `account_acct`, `limit` |
| `get_trends` | `kind` (tags, statuses, links), `limit` |
| `get_followed_hashtags` | `limit` |
| `follow_hashtag` / `unfollow_hashtag` | `hashtag` |
| `browse_directory` | `order`, `local_only`, `limit` |
| `get_suggested_follows` | `limit` |
| `get_conversations` | `limit` |

### The graph

| Tool | Arguments |
|---|---|
| `get_account` | `acct`, the profile plus the relationship in one call |
| `get_followers` / `get_following` | `acct`, `limit` |
| `get_relationships` | `accts[]` |
| `follow_account` | `acct`, `notify`, `reblogs` |
| `unfollow_account` | `acct` |
| `mute_account` | `acct`, `duration` |
| `unmute_account` | `acct` |
| `block_account` | `acct`, `confirm` |
| `unblock_account` | `acct` |
| `block_domain` | `domain`, `confirm` |
| `unblock_domain` | `domain` |
| `get_mutes` / `get_blocks` / `get_endorsements` / `get_blocked_domains` | `limit` |
| `get_follow_requests` | `limit` |
| `answer_follow_request` | `acct`, `decision` |

### Notifications and lists

| Tool | Arguments |
|---|---|
| `get_notifications` | `types[]`, `exclude_types[]`, `limit`, `max_id`, `since_id` |
| `get_read_position` | none |
| `mark_read` | `notifications_id`, `home_id` |
| `dismiss_notification` | `id` |
| `clear_notifications` | `confirm` |
| `get_lists` / `create_list` / `delete_list` | `title`, `replies_policy`, `exclusive`, `id`, `confirm` |
| `get_list_members` / `add_to_list` / `remove_from_list` | `id`, `accts[]` |
| `get_announcements` | `include_read` |

`mark_read` uses Mastodon's read markers, which sync to the web app and every other client. `clear_notifications` deletes them permanently, which is not the same thing.

### Resources and prompts

Three resources: `mastodon://accounts`, `mastodon://concepts`, `mastodon://output-format`.

Three prompts: **catch-up**, **draft-thread**, **find-my-people**.

---

## 6. Writing safely

A status is public the instant it lands, and federation means deleting it does not pull it back off the instances that already have it.

So these refuse to run without `confirm: true`:

`post_status`, `post_thread`, `edit_status`, `delete_status`, `update_profile`, `vote_poll`, `report`, `block_account`, `block_domain`, `clear_notifications`, `delete_list`

`vote_poll` is on the list because a Mastodon vote cannot be changed or withdrawn. `report` is on it because it reaches human moderators.

Favourites, boosts, follows and mutes are **not** guarded. Each is one call to undo, and a confirmation on every favourite would only train the model to pass `confirm` reflexively.

### Turning writes off entirely

```bash
MASTODON_READ_ONLY=1        # 39 read tools, every write hidden from the list
MASTODON_ALLOW_DESTRUCTIVE=0 # keeps favourites and follows, blocks posting and deleting
MASTODON_AUDIT_LOG=~/.mastodon-mcp/writes.jsonl
```

The audit log is one JSON line per attempted write, allowed and blocked alike, written mode 0600.

### Prompt injection

Everything from a timeline, a search, a notification or a conversation is text other people wrote, and on an open federated network literally anyone can put text in front of you. The server tells the model to treat all of it as data. Do not rely on that alone: `MASTODON_READ_ONLY=1` for an agent working through someone else's content is the real defence.

---

## 7. Writing statuses

### The character limit is not 500

It is whatever your instance says. Measured on 2026-08-31:

| Instance | Characters | Poll options |
|---|---:|---:|
| mastodon.social | 500 | 4 |
| fosstodon.org | 500 | 4 |
| infosec.exchange | **11,000** | **10** |

`get_instance_info` reports yours. This server reads it once per instance and checks against the real number, so a 2,000-character post is accepted where it is legal and refused with the actual limit where it is not.

Mastodon also does not count characters the way `String.length` does:

- **a URL always counts as 23**, however long it really is
- **the domain half of a remote mention is free**: `@alice@some.very.long.host` costs `@alice`

Both rules are implemented, so a link-heavy status is not refused for being over a limit it is not actually over.

### Media

- Up to whatever the instance allows, by public URL or `data:` URI.
- **Alt text is expected**, not optional. Mastodon's culture treats a missing description as rude and some instances flag it automatically.
- `focus` sets the visual centre as `x,y` between -1 and 1, which is what Mastodon crops thumbnails around. Without it, a portrait photo is routinely cropped to the subject's chest.
- Uploads are polled until the instance finishes processing. Attaching an id before it is ready fails with a 422 that does not explain itself.

### Content warnings

`spoiler_text` hides the body behind a warning. Used far more here than on other networks: politics, spoilers, food, health, and anything long. Not using one where the culture expects it is the most common way to be rude on Mastodon.

### Visibility

| | Who sees it |
|---|---|
| `public` | everyone, including the public timelines |
| `unlisted` | everyone, but not in the public timelines |
| `private` | your followers |
| `direct` | only the accounts mentioned |

A direct message is a status with `visibility: direct`, not a separate inbox. It is not encrypted, and admins on both instances can read it.

### Threads

`post_thread` takes an array and threads each part to the last. Every part is checked against the instance's limit **before anything is posted**, so a thread never half-publishes because part four was too long.

### Editing

Mastodon keeps a public revision history and the post keeps its boosts, replies and favourites, so `edit_status` is almost always better than delete-and-repost.

Call `get_status_source` first. The rendered content is HTML with links rewritten; editing that back would mangle every link in the post.

---

## 8. Reading statuses

Timelines, threads and search results come back as tagged text rather than raw API JSON. Measured on five real trending statuses from mastodon.social: 3,815 characters instead of 26,439, about 950 tokens instead of 6,600.

```xml
<statuses count="2" source="home timeline" next_max_id="…">
  <status id="1234" url="https://…" author="alice@example.social" author_name="Alice"
          posted_at="2026-08-31T09:14:02.000Z" visibility="public"
          content_warning="politics" you_favourited="true">
    <content>The text, with links restored to their real targets.</content>
    <media type="image" url="https://…" alt="…" />
    <engagement>12 favourites, 3 boosts, 1 replies</engagement>
  </status>

  <boost by="bob@other.social" at="2026-08-31T08:02:00.000Z">
    <status …>…</status>
  </boost>
</statuses>
```

- `posted_at` and `edited_at` are ISO-8601 UTC, so timestamps compare.
- A boost **wraps** the original rather than flattening it, so who said what is never ambiguous.
- `content_warning` is an attribute, so you can see a warning was set without the body being hidden from you.
- `<media>` carries `missing_alt="true"` when there is no description, worth flagging before boosting something.
- **Link targets come from the underlying `href`.** Mastodon deliberately truncates the visible text of a long link, so the displayed text is not followable. Stripping the HTML throws the real URL away.
- Mentions are rebuilt into full `@user@instance` handles. The raw markup carries only `@alice`, so a local alice and a remote alice are otherwise indistinguishable.
- `next_max_id` continues the listing.

---

## 9. What makes Mastodon different

Worth knowing before you point an agent at it.

**Federation.** There is no mastodon.com. Thousands of independently run instances talk to each other. Your instance decides your limits, what it can show you, and which servers it federates with.

**A post that "does not exist" may just not have arrived.** Your instance can only show you what it has federated in. Searching for the post's URL with `resolve` on makes it go and fetch it.

**Search is usually not full-text.** Most instances only index your own posts and ones you interacted with. A thin result set is the instance's policy, not a bad query.

**No algorithm.** Timelines are chronological. Discovery is hashtags, trends, lists and the directory. **Following a hashtag** puts every public post carrying it into your home timeline, and it is how most people build a feed.

**Boosts, not quotes.** There is no native quote post. To comment on something, post a status containing its URL.

**Not everything is Mastodon.** Pleroma, Akkoma, GoToSocial and others speak the same API. `get_instance_info` reports the software, and `doctor` warns you when features like editing or trends may be missing.

---

## 10. How it works

```
src/
  index.ts              entry: stdio, --http, login, logout, doctor
  config.ts             credentials, and which account acts
  server.ts             tools, resources, prompts
  safety.ts             the write guard and MCP annotations
  doctor.ts             setup diagnosis, including OAuth scopes

  auth/
    login.ts            registers the app, runs OAuth, stores the token
    store.ts            ~/.mastodon-mcp/accounts.json, mode 0600

  api/
    client.ts           REST, Link-header pagination, retry, throttle
    errors.ts           one class per failure, each naming its fix
    instance.ts         per-instance limits, read once and cached

  content/
    html.ts             status HTML to markdown, links and mentions restored
    media.ts            upload by URL or data URI, with a processing poll
    text.ts             Mastodon's own character counting rules

  format/
    statuses.ts         the tagged output format

  tools/
    kit.ts index.ts accounts.ts statuses.ts engage.ts timelines.ts
    discover.ts graph.ts notifications.ts
```

Two dependencies: the MCP SDK and zod. No Mastodon client library: the API is plain REST and the parts that are actually hard, Link-header pagination and the HTML conversion, are not in the libraries anyway.

**Pagination.** Mastodon returns no cursor in the body. It returns a `Link:` header carrying `max_id`, and following it is the only way past 40 results. Every listing here does.

**Rate limits.** Mastodon sends real `X-RateLimit-Remaining` and an ISO `X-RateLimit-Reset`, which is more than most APIs give you. Retries wait for the actual reset rather than guessing.

---

## 11. Your data

Nothing is uploaded anywhere but your instance.

| | Where |
|---|---|
| Access tokens | `~/.mastodon-mcp/accounts.json`, mode 0600, or your environment |
| OAuth client secret | Used once during `login`, never stored |
| Posts and reads | Between you and your instance |
| Audit log | Only the file you name in `MASTODON_AUDIT_LOG` |

No telemetry, no analytics, no phone-home. The only hosts contacted are the instances you configured, plus whatever URL you hand to `media[].url`.

---

## 12. Risks

- **An access token reaches your whole account.** It can post, delete, follow and block as you. Revoke it at `https://your-instance/oauth/authorized_applications`.
- **Posting is public and federated.** Deleting does not pull a status back off the instances that already have it.
- **Blocking severs follows permanently.** Unblocking does not restore them.
- **`block_domain` is very blunt.** It hides an entire instance and removes those followers.
- **Anything you read is untrusted text**, from an open network anyone can post to.
- **Your instance admin can read your direct messages.** So can the admin on the other end. They are not encrypted.
- **Rate limits are real.** A bulk unfollow of a thousand accounts will hit them.

If any of that is more than you want to hand an agent, `MASTODON_READ_ONLY=1` gives you 39 tools that cannot change anything.

---

## 13. Troubleshooting

**`mastodon-mcp doctor`** first. It names the failing step and the fix.

| Symptom | Cause |
|---|---|
| Reads work, the first post 403s | The token has no `write` scope. `doctor` catches this. Re-run `login` |
| "rejected the access token" | Revoked, or it belongs to a different instance |
| "No account found for …" | Use the full `@user@instance` form |
| A post that exists returns 404 | Your instance has never federated it. `search` its URL with `resolve` on |
| Search returns almost nothing | Most instances do not full-text index public statuses |
| `translate_status` 404s | The instance has no translation backend configured |
| "Status is N characters" | Check `get_instance_info`; the limit is per instance |
| Media upload times out | Large video. The id stays valid; retry the post with `media_ids` |
| "will not run without confirm: true" | Working as intended. See [section 6](#6-writing-safely) |
| Edits, polls or trends missing | Not a Mastodon server. `get_instance_info` reports the software |

---

## 14. Build from source

```bash
git clone https://github.com/thenavidm/mastodon-mcp.git
cd mastodon-mcp
npm install
npm run build
npm test
node dist/index.js login your-instance.social
```

Then point your client at `node /absolute/path/to/mastodon-mcp/dist/index.js`.

```bash
npm run typecheck   # tsc --noEmit
npm run dev         # tsc --watch
npm test            # vitest, 50 tests
```

---

## Environment variables

| Variable | Default | What it does |
|---|---|---|
| `MASTODON_URL` | none | Your instance, e.g. https://mastodon.social |
| `MASTODON_ACCESS_TOKEN` | none | An access token for it |
| `MASTODON_ACCOUNTS` | none | JSON array, for several accounts across instances |
| `MASTODON_DEFAULT_ACCOUNT` | first configured | Which handle acts when a tool names none |
| `MASTODON_MCP_HOME` | `~/.mastodon-mcp` | Where the account store lives |
| `MASTODON_READ_ONLY` | `0` | Hide every write from the tool list |
| `MASTODON_ALLOW_DESTRUCTIVE` | `1` | `0` blocks posting, editing and deleting |
| `MASTODON_AUDIT_LOG` | none | Append-only log of every attempted write |
| `MASTODON_REQUEST_TIMEOUT_MS` | `30000` | Per-request deadline |
| `MASTODON_MIN_REQUEST_INTERVAL_MS` | `120` | Spacing between requests |
| `MASTODON_MAX_RETRIES` | `3` | Retries on 429 and 5xx |
| `MASTODON_LOGIN_PORT` | `33517` | Loopback port for the OAuth redirect |
| `MASTODON_HTTP_PORT` | `8788` | For `--http` |
| `MASTODON_HTTP_HOST` | `127.0.0.1` | For `--http` |
| `MASTODON_HTTP_TOKEN` | none | Bearer token required by `--http` |

## Versions

See [VERSIONS.md](VERSIONS.md).

## About the author

Navid Moazzez is a leading AI business strategist and the host of the [AI Creator Summit](https://summits.navid.me/ai-creator), watched by 100,000+ creators. He helps creators and founders master AI and build their own AI Operating System (AI OS) to automate their business and life. This Mastodon MCP server is one piece of that system.

**Links**

- Personal website: [navid.me](https://navid.me)
- Store: [navid.bio](https://navid.bio)
- AI Creator Summit: [summits.navid.me/ai-creator](https://summits.navid.me/ai-creator)
- YouTube: [@thenavidm](https://youtube.com/@thenavidm?sub_confirmation=1) and [@thenavidai](https://youtube.com/@thenavidai?sub_confirmation=1)
- X: [@thenavidm](https://x.com/thenavidm)
- Instagram: [@thenavidm](https://instagram.com/thenavidm)
- LinkedIn: [thenavidm](https://linkedin.com/in/thenavidm)

## Dependencies

| Library | Licence | What it does |
|---|---|---|
| [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | MIT | The MCP server and transports |
| [zod](https://github.com/colinhacks/zod) | MIT | Tool argument schemas and validation |

## License

[MIT](./LICENSE). Free to use, modify, and share.

Not affiliated with, endorsed by, or connected to Mastodon gGmbH.

---

© 2026 NM Media. Made with ❤️ by [Navid Moazzez](https://navid.me).
