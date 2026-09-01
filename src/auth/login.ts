/**
 * `mastodon-mcp login <instance>`: registering an app and signing in, once.
 *
 * This exists because of the one genuine difference between Mastodon and every
 * other network here: **there is no central developer portal**. Every instance
 * is its own OAuth provider, so before you can get a token you have to register
 * an application *on that instance*. The usual instruction is "go to Settings,
 * Development, New application, tick these four scopes, copy the token", which
 * is five manual steps that people get wrong in the same two places every time:
 * they miss the `write` scope, or they paste the client secret instead of the
 * access token.
 *
 * `POST /api/v1/apps` is unauthenticated, precisely so a client can register
 * itself. So this does the whole thing: registers the app, opens the browser,
 * catches the redirect on a loopback port, exchanges the code, verifies the
 * token, and appends the account to the store.
 *
 * Two escape hatches, because not every environment has a browser:
 *   --oob      print the URL, you paste back the code
 *   --token    skip OAuth entirely and store a token you already have
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { randomBytes } from "node:crypto";
import { normalizeHandle, normalizeInstance, type Account } from "../config.js";
import { saveAccount, storePath } from "./store.js";

/**
 * Scopes requested.
 *
 * `read write follow` is the set every tool here needs. `push` is deliberately
 * not requested: nothing subscribes to push notifications, and asking for a
 * permission you never use is how a token ends up more dangerous than the tool.
 */
const SCOPES = "read write follow";
const OOB_REDIRECT = "urn:ietf:wg:oauth:2.0:oob";

type AppCredentials = { client_id: string; client_secret: string };

/** Register this client as an application on the instance. No auth needed. */
async function registerApp(instance: string, redirectUri: string): Promise<AppCredentials> {
  const body = new URLSearchParams({
    client_name: "mastodon-mcp",
    redirect_uris: redirectUri,
    scopes: SCOPES,
    website: "https://github.com/navidmoazzez/mastodon-mcp",
  });
  const response = await fetch(`${instance}/api/v1/apps`, { method: "POST", body });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `${instance} refused to register the application (HTTP ${response.status}). ${text.slice(0, 300)}`,
    );
  }
  const app = JSON.parse(text) as AppCredentials;
  if (!app.client_id || !app.client_secret) {
    throw new Error(`${instance} returned no client credentials.`);
  }
  return app;
}

async function exchangeCode(
  instance: string,
  app: AppCredentials,
  code: string,
  redirectUri: string,
): Promise<string> {
  const body = new URLSearchParams({
    client_id: app.client_id,
    client_secret: app.client_secret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    scope: SCOPES,
  });
  const response = await fetch(`${instance}/oauth/token`, { method: "POST", body });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Token exchange failed (HTTP ${response.status}). ${text.slice(0, 300)}`);
  }
  const token = (JSON.parse(text) as { access_token?: string }).access_token;
  if (!token) throw new Error("The instance returned no access token.");
  return token;
}

/** Confirm the token works and find out who it belongs to. */
async function verify(instance: string, token: string): Promise<{ acct: string; url: string }> {
  const response = await fetch(`${instance}/api/v1/accounts/verify_credentials`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `The token did not work (HTTP ${response.status}). ${text.slice(0, 200)}`,
    );
  }
  const me = JSON.parse(text) as { acct?: string; url?: string };
  const host = instance.replace(/^https?:\/\//, "");
  // `acct` is bare for a local account, so the instance is appended to make a
  // handle that is unambiguous across several connected servers.
  const acct = me.acct?.includes("@") ? me.acct : `${me.acct ?? "unknown"}@${host}`;
  return { acct: normalizeHandle(acct), url: me.url ?? "" };
}

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(command, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // No browser is fine. The URL was printed too.
  }
}

/** Catch the OAuth redirect on a loopback port, the standard native-app flow. */
async function awaitLoopbackCode(
  port: number,
  expectedState: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>mastodon-mcp</title>
         <body style="font:16px/1.5 system-ui;margin:4rem auto;max-width:32rem;text-align:center">
         <h1>${error ? "Sign-in failed" : "Signed in"}</h1>
         <p>${error ? escapeHtml(error) : "You can close this tab and go back to the terminal."}</p>`,
      );

      server.close();
      if (error) reject(new Error(`The instance returned "${error}".`));
      else if (state !== expectedState) reject(new Error("State mismatch; the sign-in was not the one we started."));
      else if (!code) reject(new Error("The instance redirected without a code."));
      else resolve(code);
    });

    server.on("error", reject);
    server.listen(port, "127.0.0.1");
    // Long enough to find the password manager, short enough not to hang a script.
    setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for the browser. Re-run with --oob to paste the code by hand."));
    }, 5 * 60_000);
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

export async function runLogin(argv: string[]): Promise<number> {
  const positional = argv.filter((a) => !a.startsWith("-"));
  const instance = normalizeInstance(positional[0] ?? "");
  const oob = argv.includes("--oob");
  const tokenFlag = argv.find((a) => a.startsWith("--token="))?.split("=").slice(1).join("=");

  if (!instance) {
    process.stderr.write(
      "Usage: mastodon-mcp login <instance> [--oob] [--token=…]\n" +
        "  e.g. mastodon-mcp login mastodon.social\n\n" +
        "Registers an application on that instance and signs you in. No developer\n" +
        "portal and no manual app setup: POST /api/v1/apps is unauthenticated, so\n" +
        "this does it for you.\n\n" +
        "  --oob        print the URL and paste the code back, for a headless box\n" +
        "  --token=…    store a token you already made, skipping OAuth entirely\n",
    );
    return 1;
  }

  // Straight token path, for someone who already made an app by hand.
  if (tokenFlag) {
    const me = await verify(instance, tokenFlag);
    const account: Account = { instance, accessToken: tokenFlag, handle: me.acct };
    const path = saveAccount(account);
    process.stdout.write(`Saved @${me.acct} to ${path}\n`);
    return 0;
  }

  process.stdout.write(`Registering mastodon-mcp on ${instance}…\n`);

  const state = randomBytes(16).toString("hex");
  const port = Number(process.env.MASTODON_LOGIN_PORT ?? 0) || 33_517;
  const redirectUri = oob ? OOB_REDIRECT : `http://127.0.0.1:${port}/callback`;

  const app = await registerApp(instance, redirectUri);

  const authorize = new URL(`${instance}/oauth/authorize`);
  authorize.searchParams.set("client_id", app.client_id);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", SCOPES);
  if (!oob) authorize.searchParams.set("state", state);

  let code: string;
  if (oob) {
    process.stdout.write(`\nOpen this and approve the request:\n\n  ${authorize}\n\n`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    code = (await rl.question("Paste the code shown afterwards: ")).trim();
    rl.close();
  } else {
    // The listener starts before the browser, so a fast approval cannot arrive
    // before anything is there to catch it.
    const waiting = awaitLoopbackCode(port, state);
    process.stdout.write(`\nOpening your browser. If nothing happens, go to:\n\n  ${authorize}\n\n`);
    openBrowser(authorize.toString());
    code = await waiting;
  }

  if (!code) {
    process.stderr.write("No code received.\n");
    return 1;
  }

  const token = await exchangeCode(instance, app, code, redirectUri);
  const me = await verify(instance, token);
  const path = saveAccount({ instance, accessToken: token, handle: me.acct });

  process.stdout.write(
    `\nSigned in as @${me.acct}\n` +
      `Saved to ${path} (mode 0600)\n\n` +
      `Run \`mastodon-mcp login <other-instance>\` again to add another account.\n` +
      `Revoke this any time from ${instance}/oauth/authorized_applications\n`,
  );
  return 0;
}

export { storePath };
