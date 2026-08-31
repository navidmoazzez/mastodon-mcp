#!/usr/bin/env bash
# Build mastodon-mcp from source and register it with Claude Code.
#
# For people who would rather not wait for the npm release, or who want to run
# a local checkout. Everything it does is one of the commands in README §14.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

command -v node >/dev/null || { echo "node 20+ is required"; exit 1; }
major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 20 ] || { echo "node 20+ is required, found $(node -v)"; exit 1; }

echo "==> installing dependencies"
( cd "$here" && npm ci --silent )

echo "==> building"
( cd "$here" && npm run build --silent )

echo "==> running tests"
( cd "$here" && npm test --silent )

if ! command -v claude >/dev/null; then
  echo
  echo "Built. Point your MCP client at:"
  echo "  node $here/dist/index.js"
  exit 0
fi

echo "==> registering with Claude Code"
claude mcp remove mastodon 2>/dev/null || true
claude mcp add mastodon -- node "$here/dist/index.js"

echo
echo "One more step. Sign in to your instance:"
echo
echo "  node $here/dist/index.js login <your-instance>"
echo
echo "That registers the app for you; there is no developer portal to visit."
echo "Then check it with:"
echo
echo "  node $here/dist/index.js doctor"
