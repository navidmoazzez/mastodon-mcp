# Install

Mastodon has a real, documented, public REST API. There is **no central developer
portal**: every instance is its own OAuth provider, so an application has to be
registered on the instance your account lives on.

`POST /api/v1/apps` is unauthenticated precisely so a client can register itself,
which is why setup here is one command instead of five manual steps.

## Prerequisites

Node 20 or newer. Nothing else.

## Install and sign in

```bash
npx -y @thenavidm/mastodon-mcp-cli login mastodon.social
claude mcp add mastodon -- npx -y @thenavidm/mastodon-mcp-cli
```

Or in any client's MCP config, after running `login` once:

```json
{
  "mcpServers": {
    "mastodon": {
      "command": "npx",
      "args": ["-y", "@thenavidm/mastodon-mcp-cli"]
    }
  }
}
```

## The command line

The same package installs both binaries, so nothing extra is needed for the
shell surface:

```bash
npm i -g @thenavidm/mastodon-mcp-cli
mastodon-cli --version
mastodon-cli                 # every command, one line each, writes marked
```

Or without installing anything:

```bash
npx -y -p @thenavidm/mastodon-mcp-cli mastodon-cli
```

`mastodon-mcp` is the server an MCP client launches; `mastodon-cli` is the same
76 tools as shell commands. They share the account store, so `login` once and
both work.

## Claude Desktop, without a terminal

Download the `.mcpb` from the
[latest release](https://github.com/thenavidm/mastodon-mcp-cli/releases/latest)
and double click it. It vendors its dependencies, so nothing has to be
installed first, and it asks for your instance URL and an access token in the
install dialog. Make that token at your instance's Settings, Development, New
application, with the **read** and **write** scopes.

## What `login` does

1. Registers `mastodon-mcp` as an application on your instance
2. Opens `/oauth/authorize`, asking for `read write follow`
3. Catches the redirect on `127.0.0.1:33517`
4. Exchanges the code for an access token
5. Verifies it and works out your handle
6. Writes `~/.mastodon-mcp/accounts.json`, mode 0600

`push` is not requested. Nothing here subscribes to push notifications.

### Headless machine

```bash
mastodon-mcp login mastodon.social --oob
```

Prints the URL, you paste the code back.

### A token you already have

```bash
mastodon-mcp login mastodon.social --token=YOUR_ACCESS_TOKEN
```

Or skip the store:

```bash
export MASTODON_URL=https://mastodon.social
export MASTODON_ACCESS_TOKEN=...
```

If you make the app by hand instead, tick **read**, **write** and **follow**, and
copy **"Your access token"**, not the client secret. Missing `write` is the most
common setup mistake: every read works and the first post fails with a 403 that
does not mention scopes.

## Several accounts

Run `login` once per account. They accumulate.

```bash
mastodon-mcp login mastodon.social
mastodon-mcp login fosstodon.org
export MASTODON_DEFAULT_ACCOUNT=you@mastodon.social
```

Every tool that acts as someone takes `account`, matched against the full handle,
the instance, or an unambiguous username. Or configure them directly:

```bash
export MASTODON_ACCOUNTS='[
  {"instance":"https://mastodon.social","access_token":"..."},
  {"instance":"https://fosstodon.org","access_token":"..."}
]'
```

## Verify

```bash
mastodon-mcp doctor
```

Checks the instance is reachable, reports its actual limits, verifies each token,
and checks the **scopes**, which is the failure everything else hides.

## Turning writes off

```bash
MASTODON_READ_ONLY=1          # every write disappears from the tool list
MASTODON_ALLOW_DESTRUCTIVE=0  # keeps favourites and follows, blocks posting
MASTODON_AUDIT_LOG=~/.mastodon-mcp/writes.jsonl
```

## Revoking

`https://your-instance/oauth/authorized_applications`. `mastodon-mcp logout
<handle>` only forgets the token locally; it does not revoke it.

## When it breaks

| Symptom | Cause |
|---|---|
| Reads work, first post 403s | Token has no `write` scope. Re-run `login` |
| "rejected the access token" | Revoked, or from a different instance |
| "Status is N characters" | The limit is per instance. Check `get_instance_info` |
| A post 404s that clearly exists | Your instance never federated it. Search its URL with `resolve` on |
| Search finds almost nothing | Most instances do not full-text index public statuses |
