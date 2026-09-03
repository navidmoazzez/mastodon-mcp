# Security

## Reporting a vulnerability

[Report it privately](https://github.com/thenavidm/mastodon-mcp-cli/security/advisories/new).
Please do not open a public issue for a security problem: an issue is visible to
everyone the moment you file it, including whoever would use the bug.

Include what you did, what happened, and what you expected. A proof of concept
helps. Reporters are credited in the fix notes unless they would rather not be.

## What this server holds

**An access token**, in `MASTODON_ACCESS_TOKEN`, or one per account inside
`MASTODON_ACCOUNTS`. A token is the account: anyone holding it can post, read
your notifications and send messages as you, within the scopes it was granted.

It is not your password, and that matters: a token can be revoked on its own
from your instance's settings, under Preferences then Development, without
changing your password or touching any other app.

**An audit log**, in the data directory, recording every attempted write.

Tokens are per instance. A token for one server is meaningless on another, so
the blast radius of a leak is one account on one instance.

Nothing leaves your machine except calls to the instances you configured. There
is no telemetry and no backend.

## Write safety

Writes work by default, because posting is the point of the server. A server
where every write needs a flag teaches the operator to set that flag
permanently, which is worse than no protection because it looks like protection.

Three graduated mechanisms instead:

**`confirm: true` on the operations that reach other people.** Posting, threads,
deleting, blocking. A post is public the instant it lands, and deleting it does
not pull it out of the feeds, caches and clients that already have it. There is
no unsend.

Likes, reposts, follows and mutes are not guarded. Each is one click to undo,
and confirming everything trains the model to pass `confirm` reflexively, which
is worse than not asking.

**`MASTODON_READ_ONLY=1` removes every write from the tool list.** Not a refusal
at call time: the tools are never registered. A model cannot call a tool it
cannot see, and cannot argue with a refusal it never receives. This is the
setting for pointing an untrusted agent at an account.

**`MASTODON_AUDIT_LOG=<path>` records every attempted write**, allowed and
blocked alike, one line each. The model has no tool to read or edit that file.

## Untrusted content

Posts, replies, quotes, display names and bios are written by other people.
Anything the timeline or a search returns is text a stranger chose, and
"summarise my notifications" is one of the first things anyone asks.

Treat that content as data to report on, never as instructions. The risk is
highest when writes are enabled, because a reply is a text field aimed at an
agent that can post.

## Running it over HTTP

The HTTP transport has no authentication of its own. It belongs behind TLS and
an authenticating reverse proxy.

Do not expose it directly. It holds a live credential for your account, and an
open endpoint hands it to anyone who finds it.

## Good-faith research

Read, run and pull apart anything here. Nobody but the maintainer can change
this repository, so nothing you do while investigating puts it at risk.

The care is owed to the service the tool talks to, not to the code. When
testing, use your own account and your own data. Do not point it at somebody
else's, and do not hammer a shared API to the point where other people notice.
If a test could affect anyone but you, stop and send a private report first.

Research done in that spirit is welcome, and nothing here is a trap.

## Supported versions

The latest published version gets fixes. Given the size of this project, older
versions do not.
