#!/usr/bin/env node
/**
 * Entry point.
 *
 * `mastodon-mcp`                 stdio, which is what MCP clients launch
 * `mastodon-mcp --http`          HTTP, for running it somewhere always on
 * `mastodon-mcp login <host>`    register an app on an instance and sign in
 * `mastodon-mcp logout <who>`    remove a stored account
 * `mastodon-mcp doctor`          check the setup and say what is wrong
 * `mastodon-cli`                 the same tools as shell commands
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer, VERSION } from "./server.js";
import { loadConfig } from "./config.js";
import { httpOptionsFromEnv, startHttpServer } from "./transport/http.js";
import { runCli, isCliCommand } from "./cli.js";

const HELP = `mastodon-mcp ${VERSION}

  mastodon-mcp                      Run over stdio. This is what an MCP client launches.
  mastodon-mcp login <instance>     Register an app on that instance and sign in.
  mastodon-mcp logout <handle>      Remove a stored account.
  mastodon-mcp doctor               Check the setup and report what is wrong.
  mastodon-mcp --http [--port=N]    Run over HTTP, for a machine that is always on.
  mastodon-mcp --version            Print the version.

Getting started:

  mastodon-mcp login mastodon.social

That is the whole setup. Mastodon has no central developer portal: every instance is
its own OAuth provider, and POST /api/v1/apps is unauthenticated precisely so a client
can register itself. So this registers the app, opens your browser, and stores the
token. Run it again for a second account on any instance.

  --oob         print the URL and paste the code back, for a headless machine
  --token=…     store a token you already made by hand, skipping OAuth

Credentials, in priority order:
  MASTODON_ACCOUNTS         JSON array, for several accounts across instances:
                            [{"instance":"https://mastodon.social","access_token":"…"}]
  MASTODON_URL              your instance, e.g. https://mastodon.social
                            MASTODON_INSTANCE_URL and MASTODON_API_BASE_URL are aliases
  MASTODON_ACCESS_TOKEN     an access token for it
  MASTODON_HANDLE           its full handle, resolved on first use when absent
  ~/.mastodon-mcp/accounts.json   whatever \`mastodon-mcp login\` stored

Options:
  MASTODON_DEFAULT_ACCOUNT           which handle acts when a tool names none
  MASTODON_READ_ONLY=1               hide every write from the tool list
  MASTODON_ALLOW_DESTRUCTIVE=0       keep writes, block posting and deleting
  MASTODON_REQUEST_TIMEOUT_MS        per-request deadline, default 30000
  MASTODON_MIN_REQUEST_INTERVAL_MS   spacing between requests, default 120
  MASTODON_MAX_RETRIES               retries on 429 and 5xx, default 3
  MASTODON_USER_AGENT                override the User-Agent sent to the instance
  MASTODON_AUDIT_LOG                 append-only log of every attempted write
  MASTODON_HTTP_PORT / _HOST / _TOKEN  for --http

https://github.com/thenavidm/mastodon-mcp-cli
`;

/**
 * One entry point, two programs. `mastodon-mcp` is the server and must stay
 * silent on stdout; `mastodon-cli` is the one a person types. Running the CLI
 * binary with no arguments is someone asking what they can type, so it lists
 * the commands rather than hanging on a transport that will never speak.
 */
function invokedAsCli(): boolean {
  const name = (process.argv[1] ?? "").split("/").pop() ?? "";
  return name.startsWith("mastodon-cli");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (invokedAsCli() && argv.length === 0) {
    process.exitCode = await runCli(["tools"]);
    return;
  }

  // Checked before --help and --version so `<tool> --help` reaches the tool.
  // A bare `--help` starts with a dash, so it falls through to the block below.
  if (isCliCommand(argv)) {
    process.exitCode = await runCli(argv);
    return;
  }

  // An unknown word used to fall through and start the server, which then sat
  // waiting on stdin: a typo looked like a hang, and scripts saw exit code 0.
  // `doctor`, `login` and `logout` belong to the entry point rather than the
  // tool list, and they are the first things someone types when nothing works
  // yet. Rejecting them as unknown commands sent people to the server binary
  // to fix the CLI.
  const ENTRY_COMMANDS = new Set(["doctor", "login", "logout", "help"]);

  if (
    invokedAsCli() &&
    command !== undefined &&
    !command.startsWith("-") &&
    !ENTRY_COMMANDS.has(command)
  ) {
    process.stderr.write(
      `${JSON.stringify({ error: `Unknown command '${command}'. Run \`mastodon-cli\` to list them.` }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (argv.includes("--help") || argv.includes("-h") || command === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (command === "login") {
    const { runLogin } = await import("./auth/login.js");
    process.exitCode = await runLogin(argv.slice(1));
    return;
  }
  if (command === "logout") {
    const { removeAccount, storePath } = await import("./auth/store.js");
    const who = argv[1];
    if (!who) {
      process.stderr.write("Usage: mastodon-mcp logout <handle or instance>\n");
      process.exitCode = 1;
      return;
    }
    const removed = removeAccount(who);
    process.stdout.write(
      removed
        ? `Removed ${removed} account(s) from ${storePath()}.\nRevoke the token itself at your instance's /oauth/authorized_applications.\n`
        : `Nothing matching "${who}" was stored.\n`,
    );
    return;
  }
  if (command === "doctor") {
    const { runDoctor } = await import("./doctor.js");
    process.exitCode = await runDoctor();
    return;
  }

  const config = loadConfig();
  const built = buildServer(config);

  // Warn, never block. A network check at startup would delay the handshake,
  // and the failure is more actionable on the tool call that hits it.
  if (config.accounts.length === 0) {
    process.stderr.write(
      "[mastodon-mcp] No account configured. Run `mastodon-mcp login <your-instance>`. Every tool will report the missing setup until then.\n",
    );
  }

  const shutdown = async (close?: () => Promise<void>): Promise<void> => {
    if (close) await close().catch(() => undefined);
    process.exit(0);
  };

  if (argv.includes("--http")) {
    const { close } = await startHttpServer(built, httpOptionsFromEnv(argv));
    process.on("SIGTERM", () => void shutdown(close));
    process.on("SIGINT", () => void shutdown(close));
    return;
  }

  const transport = new StdioServerTransport();
  await built.server.connect(transport);

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((error: unknown) => {
  process.stderr.write(`[mastodon-mcp] ${(error as Error).message}\n`);
  process.exit(1);
});
