import { sValidator } from "@hono/standard-validator";
import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { RouterRoute } from "hono/types";

import { relayAnalytics } from "./analytics";
import {
  createD1AuthServices,
  finishGitHubSignIn,
  invalidSignInQuery,
  readSession,
  SignInCallbackQuerySchema,
  SignInQuerySchema,
  signOut,
  startGitHubSignIn,
  type AuthServices,
} from "./auth";
import {
  CloudCopyQuerySchema,
  cloudProjectNotFound,
  CloudProjectPathSchema,
  cloudProjectTooLargeMessage,
  CloudSaveBodySchema,
  createD1CloudSyncServices,
  deleteCloudProject,
  invalidCloudDelete,
  invalidCloudProjectId,
  invalidCloudSave,
  maxSaveBodyBytes,
  readCloudProject,
  readCloudStatus,
  saveCloudProject,
  type CloudSyncServices,
} from "./cloud-sync";
import {
  CommunityQuerySchema,
  createD1CommunityServices,
  invalidCommunityQuery,
  ListingBodySchema,
  listCommunityShares,
  listInCommunity,
  maxListingBodyBytes,
  reportCommunityShare,
  shareNotListed,
  unlistFromCommunity,
  type CommunityServices,
} from "./community";
import {
  ConnectRoleQuerySchema,
  ConnectRoomPathSchema,
  handleConnectRoute,
  invalidRoom,
  type ConnectRouteServices,
} from "./connect-route";
import { createAppContentSecurityPolicy, createEmbedContentSecurityPolicy } from "./content-security-policy";
import {
  applyDocumentMeta,
  createD1DocumentServices,
  isHiddenFromSearch,
  resolveDocumentMeta,
  resolveDocumentRoute,
  serveRobots,
  serveSitemap,
  type DocumentServices,
} from "./document-meta";
import { answerUnexpectedError } from "./error-boundary";
import { createApiError } from "./http";
import { getRequestId } from "./logger";
import {
  createD1MySharesServices,
  invalidMySharesQuery,
  listMyShares,
  MySharesQuerySchema,
  type MySharesServices,
} from "./my-shares";
import type { WorkerEnvironment } from "./platform";
import {
  createD1PlaygroundServices,
  deleteShare,
  invalidIdempotencyKey,
  LinkPathSchema,
  maxPublishBodyBytes,
  playgroundNotFound,
  publishPlayground,
  PublishHeadersSchema,
  pushChanges,
  readOwnership,
  readPlayground,
  ShareBodySchema,
  type PlaygroundServices,
} from "./playgrounds";
import {
  createD1RecordedRunServices,
  invalidRecording,
  maxRecordingBodyBytes,
  readRecordedRun,
  RecordingBodySchema,
  recordingNotFound,
  recordingTooLargeMessage,
  recordRun,
  type RecordedRunServices,
} from "./recorded-runs";
import { serveRuntimeAsset } from "./runtime-assets";
import { createD1SessionServices, readSessionUser, type ReadCurrentUser } from "./session";
import { createInvalidJsonError, limitBody, refuseInvalid, requireJson, requireSameOrigin } from "./validation";

/** The services the routes run with. */
export interface WorkerServices {
  auth: AuthServices;
  cloudSync: CloudSyncServices;
  community: CommunityServices;
  connect: ConnectRouteServices;
  documents: DocumentServices;
  myShares: MySharesServices;
  playgrounds: PlaygroundServices;
  recordedRuns: RecordedRunServices;
}

/** The services the Worker runs with: D1, the session cookie, the clock and random ids. */
export function createD1WorkerServices(): WorkerServices {
  const sessionServices = createD1SessionServices();
  const currentUser: ReadCurrentUser = (request, environment) => readSessionUser(request, environment, sessionServices);

  return {
    auth: createD1AuthServices(),
    cloudSync: createD1CloudSyncServices({ currentUser }),
    community: createD1CommunityServices({ currentUser }),
    connect: { currentUserId: async (request, environment) => (await currentUser(request, environment))?.id ?? null },
    documents: createD1DocumentServices(),
    myShares: createD1MySharesServices({ currentUser }),
    playgrounds: createD1PlaygroundServices({ currentUser }),
    recordedRuns: createD1RecordedRunServices({ currentUser }),
  };
}

type WorkerApp = { Bindings: WorkerEnvironment; Variables: { services: WorkerServices } };

const signOutOrigin = "Signing out is available from the Drizzle Run application.";
const cloudSyncOrigin = "Cloud sync is available from the Drizzle Run application.";
const publishOrigin = "Publishing is available from the Drizzle Run application.";
const publishJson = "Send the playground snapshot as application/json.";
const listingOrigin = "Listing is available from the Drizzle Run application.";
const recordingOrigin = "Recording runs is available from the Drizzle Run application.";
const deleteShareOrigin = "Deleting a share is available from the Drizzle Run application.";
const publishBodyLimit = {
  maxBytes: maxPublishBodyBytes,
  code: "snapshot_too_large",
  message: "A published playground must be at most 1 MiB.",
};
const publishHeaders = sValidator("header", PublishHeadersSchema, refuseInvalid(invalidIdempotencyKey));
const linkPath = sValidator("param", LinkPathSchema, refuseInvalid(playgroundNotFound));

/**
 * Create the Worker's routes
 *
 * The API first, each route with the checks of its input, then one 404 or 405 for any other `/api` address. Then the
 * crawler files, the runtime assets and, for every other address, the app's assets and pages.
 */
export function createWorkerApp(services: WorkerServices) {
  const app = new Hono<WorkerApp>();

  app.use(async (c, next) => {
    c.set("services", services);
    const requestId = getRequestId(c.req.raw);

    try {
      await next();
    } catch (cause) {
      c.res = answerUnexpectedError(cause, c.req.raw);
    }

    c.header("X-Request-Id", requestId);
  });
  app.use(markHiddenFromSearch);
  app.use("/runtime-assets/*", requireCorpEmbedders);
  app.onError((error, c) => answerError(error, c.req.raw));

  app.on(
    ["GET", "POST"],
    "/api/analytics/events",
    limitBody({
      maxBytes: 64 * 1024,
      code: "analytics_too_large",
      message: "Analytics events must be at most 64 KiB.",
    }),
    (c) => relayAnalytics(c.req.raw),
  );

  // GitHub sign-in
  for (const path of getOnlyPaths) {
    app.use(path, refuseHead);
  }

  app.get(signInPath, sValidator("query", SignInQuerySchema, refuseInvalid(invalidSignInQuery)), (c) =>
    startGitHubSignIn(c.req.raw, c.env, c.req.valid("query"), c.var.services.auth),
  );
  app.get(signInCallbackPath, sValidator("query", SignInCallbackQuerySchema, refuseInvalid(invalidSignInQuery)), (c) =>
    finishGitHubSignIn(c.req.raw, c.env, c.req.valid("query"), c.var.services.auth),
  );
  app.get("/api/auth/session", (c) => readSession(c.req.raw, c.env, c.var.services.auth));
  app.post("/api/auth/logout", requireSameOrigin(signOutOrigin), (c) => signOut(c.req.raw, c.env, c.var.services.auth));

  // Cloud sync
  app.get("/api/cloud", (c) => readCloudStatus(c.req.raw, c.env, c.var.services.cloudSync));
  app.get(
    "/api/cloud/projects/:id",
    sValidator("param", CloudProjectPathSchema, refuseInvalid(cloudProjectNotFound)),
    (c) => readCloudProject(c.req.raw, c.env, c.req.valid("param"), c.var.services.cloudSync),
  );
  app.put(
    "/api/cloud/projects/:id",
    requireSameOrigin(cloudSyncOrigin),
    requireJson("Send the project as application/json."),
    sValidator("param", CloudProjectPathSchema, refuseInvalid(invalidCloudProjectId)),
    limitBody({ maxBytes: maxSaveBodyBytes, code: "cloud_project_too_large", message: cloudProjectTooLargeMessage }),
    sValidator("json", CloudSaveBodySchema, refuseInvalid(invalidCloudSave)),
    (c) =>
      saveCloudProject(
        c.req.raw,
        c.env,
        { ...c.req.valid("param"), body: c.req.valid("json") },
        c.var.services.cloudSync,
      ),
  );
  app.delete(
    "/api/cloud/projects/:id",
    requireSameOrigin(cloudSyncOrigin),
    sValidator("param", CloudProjectPathSchema, refuseInvalid(invalidCloudDelete)),
    sValidator("query", CloudCopyQuerySchema, refuseInvalid(invalidCloudDelete)),
    (c) =>
      deleteCloudProject(
        c.req.raw,
        c.env,
        { ...c.req.valid("param"), ...c.req.valid("query") },
        c.var.services.cloudSync,
      ),
  );

  // Shared playgrounds
  app.get("/api/me/shares", sValidator("query", MySharesQuerySchema, refuseInvalid(invalidMySharesQuery)), (c) =>
    listMyShares(c.req.raw, c.env, c.req.valid("query"), c.var.services.myShares),
  );
  app.post(
    "/api/playgrounds",
    requireSameOrigin(publishOrigin),
    requireJson(publishJson),
    publishHeaders,
    limitBody(publishBodyLimit),
    sValidator("json", ShareBodySchema, refuseInvalid({ status: 422, code: "invalid_share" })),
    (c) =>
      publishPlayground(
        c.req.raw,
        c.env,
        { ...c.req.valid("header"), body: c.req.valid("json") },
        c.var.services.playgrounds,
      ),
  );
  app.get("/api/playgrounds/:id", linkPath, (c) =>
    readPlayground(c.req.raw, c.env, c.req.valid("param"), c.var.services.playgrounds),
  );
  app.put(
    "/api/playgrounds/:id",
    requireSameOrigin(publishOrigin),
    requireJson(publishJson),
    linkPath,
    limitBody(publishBodyLimit),
    sValidator("json", ShareBodySchema, refuseInvalid({ status: 422, code: "invalid_share" })),
    (c) =>
      pushChanges(c.req.raw, c.env, { ...c.req.valid("param"), body: c.req.valid("json") }, c.var.services.playgrounds),
  );
  app.delete("/api/playgrounds/:id", requireSameOrigin(deleteShareOrigin), linkPath, (c) =>
    deleteShare(c.req.raw, c.env, c.req.valid("param"), c.var.services.playgrounds),
  );
  app.get("/api/playgrounds/:id/ownership", linkPath, (c) =>
    readOwnership(c.req.raw, c.env, c.req.valid("param"), c.var.services.playgrounds),
  );

  // Recorded runs
  app.get(
    "/api/playgrounds/:id/recording",
    sValidator("param", LinkPathSchema, refuseInvalid(recordingNotFound)),
    (c) => readRecordedRun(c.req.raw, c.env, c.req.valid("param"), c.var.services.recordedRuns),
  );
  app.put(
    "/api/playgrounds/:id/recording",
    requireSameOrigin(recordingOrigin),
    requireJson("Send the recorded run as application/json."),
    linkPath,
    limitBody({ maxBytes: maxRecordingBodyBytes, code: "recording_too_large", message: recordingTooLargeMessage }),
    sValidator("json", RecordingBodySchema, refuseInvalid(invalidRecording)),
    (c) =>
      recordRun(c.req.raw, c.env, { ...c.req.valid("param"), body: c.req.valid("json") }, c.var.services.recordedRuns),
  );

  // Community
  app.get("/api/community", sValidator("query", CommunityQuerySchema, refuseInvalid(invalidCommunityQuery)), (c) =>
    listCommunityShares(c.req.raw, c.env, c.req.valid("query"), c.var.services.community),
  );
  app.put(
    "/api/playgrounds/:id/listing",
    requireSameOrigin(listingOrigin),
    requireJson("Send the listing as application/json."),
    linkPath,
    limitBody({
      maxBytes: maxListingBodyBytes,
      code: "listing_too_large",
      message: "A listing must be at most 4 KiB.",
    }),
    sValidator("json", ListingBodySchema, refuseInvalid({ status: 422, code: "invalid_listing" })),
    (c) =>
      listInCommunity(
        c.req.raw,
        c.env,
        { ...c.req.valid("param"), body: c.req.valid("json") },
        c.var.services.community,
      ),
  );
  app.delete("/api/playgrounds/:id/listing", requireSameOrigin(listingOrigin), linkPath, (c) =>
    unlistFromCommunity(c.req.raw, c.env, c.req.valid("param"), c.var.services.community),
  );
  app.post(
    "/api/community/:id/report",
    requireSameOrigin("Reporting is available from the Drizzle Run application."),
    sValidator("param", LinkPathSchema, refuseInvalid(shareNotListed)),
    (c) => reportCommunityShare(c.req.raw, c.env, c.req.valid("param"), c.var.services.community),
  );

  // AI chat relay
  app.get(
    "/api/connect/rooms/:roomId",
    sValidator("param", ConnectRoomPathSchema, refuseInvalid(invalidRoom)),
    sValidator("query", ConnectRoleQuerySchema, refuseInvalid(invalidRoom)),
    (c) =>
      handleConnectRoute(
        c.req.raw,
        c.env,
        { ...c.req.valid("param"), ...c.req.valid("query") },
        c.var.services.connect,
      ),
  );

  // Any other API address
  app.all("/api/*", (c) => {
    const allowed = listAllowedMethods(app.routes, c.req.path).join(", ");

    return allowed === ""
      ? createApiError(404, "api_route_not_found", "This API route does not exist.")
      : createApiError(405, "method_not_allowed", `This route answers ${allowed}.`, {
          headers: { Allow: allowed },
        });
  });

  // Crawlers and link previews
  app.get("/robots.txt", (c) => serveRobots(new URL(c.req.url).origin, c.env));
  app.get("/sitemap.xml", (c) => serveSitemap(new URL(c.req.url).origin, c.env, c.var.services.documents, c.req.raw));

  // Runtime assets, then the app's assets and pages
  app.all("/runtime-assets/*", (c) => serveRuntimeAsset(c.req.raw, c.env.RUNTIME_ASSETS, new URL(c.req.url).pathname));
  app.all("*", (c) => serveAppAsset(c.req.raw, c.env, c.var.services.documents));

  return app;
}

const signInPath = "/api/auth/github/login";
const signInCallbackPath = "/api/auth/github/callback";

/** Routes that act on GET, spending a rate-limit slot and setting a cookie, so HEAD does not answer them. */
const getOnlyPaths: ReadonlySet<string> = new Set([signInPath, signInCallbackPath]);

/** Refuses HEAD, which Hono otherwise answers by running the GET route. */
const refuseHead: MiddlewareHandler<WorkerApp> = async (c, next) => {
  if (c.req.method === "HEAD") {
    return createApiError(405, "method_not_allowed", "This route answers GET.", { headers: { Allow: "GET" } });
  }

  return next();
};

/** Marks every response from a site hidden from search as not to be indexed or followed. */
const markHiddenFromSearch: MiddlewareHandler<WorkerApp> = async (c, next) => {
  await next();

  // A WebSocket upgrade (101) passes through as it is: a Response cannot be rebuilt with it.
  if (c.res.status !== 101 && isHiddenFromSearch(new URL(c.req.url).origin, c.env)) {
    c.header("X-Robots-Tag", "noindex, nofollow");
  }
};

/** Lets an isolated page start the runtime's workers. The app's own build files get it from public/_headers. */
const requireCorpEmbedders: MiddlewareHandler<WorkerApp> = async (c, next) => {
  await next();
  c.header("Cross-Origin-Embedder-Policy", "require-corp");
};

/** A body the JSON validator cannot parse is `invalid_json`; any other error is the Worker's own failure. */
function answerError(error: Error, request: Request): Response {
  if (!(error instanceof HTTPException) || error.status >= 500) {
    return answerUnexpectedError(error, request);
  }

  // The JSON validator throws 400 for a body it cannot parse.
  return error.status === 400 ? createInvalidJsonError() : error.getResponse();
}

const routeMethods = ["GET", "HEAD", "POST", "PUT", "DELETE"] as const;

/** The methods the routes answer at `pathname`, in a fixed order; GET answers HEAD too, except on `getOnlyPaths`. */
function listAllowedMethods(routes: readonly RouterRoute[], pathname: string): string[] {
  const methods = new Set<string>();

  for (const route of routes) {
    if (route.method !== "ALL" && toPathPattern(route.path).test(pathname)) {
      methods.add(route.method);
    }
  }

  if (methods.has("GET") && !getOnlyPaths.has(pathname)) {
    methods.add("HEAD");
  }

  return routeMethods.filter((method) => methods.has(method));
}

/** A route path such as `/api/playgrounds/:id` as a pattern for whole paths, each `:param` one segment. */
function toPathPattern(path: string): RegExp {
  const segments = path
    .split("/")
    .map((segment) => (segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  return new RegExp(`^${segments.join("/")}$`);
}

/** Serve the app's assets and pages: a page gets its document meta, then the isolation headers of a page or an embed. */
async function serveAppAsset(
  request: Request,
  environment: WorkerEnvironment,
  documents: DocumentServices,
): Promise<Response> {
  const url = new URL(request.url);
  const response = applyPublicEmbedModuleHeaders(url.pathname, await environment.ASSETS.fetch(request));
  const route = request.method === "GET" ? resolveDocumentRoute(url.pathname) : null;
  const document =
    route === null
      ? response
      : applyDocumentMeta(response, await resolveDocumentMeta(route, environment, documents, request), url.origin);

  return applyDocumentIsolationHeaders(url, document);
}

function applyPublicEmbedModuleHeaders(pathname: string, response: Response): Response {
  if (!/^\/embed\/[A-Za-z0-9._-]+\.js$/.test(pathname)) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** The app's embed routes (src/app.tsx): `/embed/:snapshotId` and `/embed/examples/:example/:step?`. */
const embedPagePattern = /^\/embed\/(?:[^/]+|examples\/[^/]+(?:\/[^/]+)?)\/?$/;

function applyDocumentIsolationHeaders(url: URL, response: Response): Response {
  if (!isAppDocument(response)) {
    return response;
  }

  const headers = new Headers(response.headers);

  // Other sites frame the embed pages, one with a malformed id included, so none gets the app's COOP. Any other
  // /embed/ path renders the full app, which only Drizzle Run may frame.
  if (embedPagePattern.test(url.pathname)) {
    headers.delete("Cross-Origin-Opener-Policy");
    headers.set("Cross-Origin-Resource-Policy", "cross-origin");
    headers.set("Document-Isolation-Policy", "isolate-and-require-corp");
    headers.set("Cross-Origin-Embedder-Policy", "require-corp");
    headers.set("Content-Security-Policy", createEmbedContentSecurityPolicy(url));
  } else {
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Cross-Origin-Embedder-Policy", "require-corp");
    headers.set("Content-Security-Policy", createAppContentSecurityPolicy(url));
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** A page of the app: the HTML shell the assets serve for any address that is not a file. */
function isAppDocument(response: Response): boolean {
  return response.headers.get("Content-Type")?.startsWith("text/html") === true;
}
