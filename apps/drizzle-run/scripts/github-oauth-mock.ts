import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { resolveDrizzleRunPorts, toLocalOrigin } from "../../../scripts/drizzle-run-ports.ts";

// Tests pick an account per browser context with the `e2e-github-user` cookie (path /github). The default is
// `octocat`.

/** The e2e GitHub App, as wrangler.jsonc's e2e environment configures it. */
/** The app the mock redirects back to, on this checkout's app port. */
const appOrigin = toLocalOrigin(resolveDrizzleRunPorts().app);

export const mockGitHubApp = { clientId: "Iv1.e2e-drizzle-run", clientSecret: "e2e-client-secret" };

const pendingCodes = new Map<string, { login: string; challenge: string | null; redirectUri: string }>();
const tokens = new Map<string, string>();

/** A stable numeric GitHub ID for repeated sign-ins with the same login. */
function toGitHubId(login: string) {
  return login === "octocat"
    ? 583231
    : Number.parseInt(createHash("sha256").update(login).digest("hex").slice(0, 8), 16);
}

function readCookie(request: IncomingMessage, name: string) {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");

    if (key === name) {
      return decodeURIComponent(value.join("="));
    }
  }

  return undefined;
}

async function readJsonBody(request: IncomingMessage) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

/**
 * Answer a mock GitHub request
 *
 * Returns false for paths outside /github, so the caller serves them as before.
 */
export async function handleGitHubMock(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (!url.pathname.startsWith("/github/")) {
    return false;
  }

  if (url.pathname === "/github/login/oauth/authorize" && request.method === "GET") {
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";

    if (
      url.searchParams.get("client_id") !== mockGitHubApp.clientId ||
      url.searchParams.get("code_challenge_method") !== "S256" ||
      !redirectUri.startsWith(`${appOrigin}/`)
    ) {
      response.writeHead(400).end("Mock GitHub: unexpected authorize request.");
      return true;
    }

    const code = randomUUID();
    pendingCodes.set(code, {
      login: readCookie(request, "e2e-github-user") ?? "octocat",
      challenge: url.searchParams.get("code_challenge"),
      redirectUri,
    });

    const callback = new URL(redirectUri);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", url.searchParams.get("state") ?? "");
    response.writeHead(302, { Location: callback.href }).end();
    return true;
  }

  if (url.pathname === "/github/login/oauth/access_token" && request.method === "POST") {
    const body = await readJsonBody(request).catch(() => ({}));
    const pending = pendingCodes.get(body.code);
    pendingCodes.delete(body.code);
    const verified =
      pending !== undefined &&
      body.client_id === mockGitHubApp.clientId &&
      body.client_secret === mockGitHubApp.clientSecret &&
      body.redirect_uri === pending.redirectUri &&
      createHash("sha256").update(String(body.code_verifier)).digest("base64url") === pending.challenge;

    if (!verified) {
      sendJson(response, 200, { error: "bad_verification_code" });
      return true;
    }

    const token = `gho_e2e_${randomUUID()}`;
    tokens.set(token, pending.login);
    sendJson(response, 200, { access_token: token, token_type: "bearer", scope: "" });
    return true;
  }

  if (url.pathname === "/github/api/user" && request.method === "GET") {
    const login = tokens.get((request.headers.authorization ?? "").replace(/^Bearer /, ""));

    if (login === undefined) {
      sendJson(response, 401, { message: "Bad credentials" });
      return true;
    }

    sendJson(response, 200, { id: toGitHubId(login), login, name: `${login} (e2e)` });
    return true;
  }

  response.writeHead(404).end();
  return true;
}
