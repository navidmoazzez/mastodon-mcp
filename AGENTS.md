# Working on mastodon-mcp-cli

For agents editing this repository. Users read the README. Driving the server is
`SKILL.md`.

## Layout

```
src/api/        client, errors
src/auth/       app registration and sign-in, per instance
src/content/    status text, media, content warnings
src/tools/      one module per group, registered in tools/index.ts
src/safety.ts   read-only, confirm, audit
src/doctor.ts   the troubleshooting command
```

## Non-negotiables

**Commit as `n@navid.me`.** Never pass `-c user.email=`. The global config is
correct and the override is the bug: the wrong address credits a blocked account
and the Contributors panel reads 0.

**Writes are on by default.** `MASTODON_READ_ONLY=1` is the opt-out and it works
by not registering the write tools, not by refusing at call time.

**`confirm: true` on operations that reach other people only.** Posting,
threads, deleting, blocking, reporting. Not favourites, boosts, follows or
mutes: each is one click to undo, and confirming everything trains the reflex
that makes the confirmation on a delete worthless.

**There is no developer portal.** Mastodon has no central place to register an
app, so the server registers its own application against whichever instance the
user names, then signs in. That is why setup is one command and why the code
carries an `auth/` directory the other servers do not need.

**Instance differences are the platform.** Character limits, poll limits, media
counts and available features vary per instance and are read from
`/api/v1/instance` rather than assumed. Never hardcode 500 characters.

**Every anticipated failure carries a message the model can act on.** Check how
the SDK surfaces errors before writing thirty of them.

## Before claiming it works

```bash
npm run build && npm test && npm run typecheck
npx @modelcontextprotocol/inspector node dist/index.js
```
