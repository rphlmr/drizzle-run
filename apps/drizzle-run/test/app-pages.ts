/**
 * Every page of the app's router, by its route, with an address a visitor can load for it
 *
 * `src/app.test.ts` fails when the router has a page this list does not name, so a new page is checked by the Worker
 * tests (its isolation headers) and by `e2e/routes.e2e.ts` (a visitor can load it and run a project from it).
 */
export const appPages = {
  "/": "/",
  "/projects": "/projects",
  "/projects/shares": "/projects/shares",
  "/examples": "/examples",
  "/examples/:slug": "/examples/relational-queries",
  "/community": "/community",
  "/p/:projectId": "/p/00000000-0000-4000-8000-000000000001",
  "/s/:snapshotId": "/s/00000000-0000-4000-8000-000000000001",
  "/*": "/no-such-page",
} as const;

/** A page route of `appPages`. */
export type AppPageRoute = keyof typeof appPages;

/** Routes with a loader or an action and no page, which `src/app.test.ts` counts as known. */
export const appResourceRoutes = ["/resources/share-publication/:linkId", "/session"] as const;

/** The embed pages, which another site frames: `e2e/embed.e2e.ts` checks them. */
export const embedPages = {
  "/embed/:snapshotId": "/embed/00000000-0000-4000-8000-000000000001",
  "/embed/examples/:example": "/embed/examples/relational-queries",
  "/embed/examples/:example/:step": "/embed/examples/relational-queries/01-relations",
} as const;
