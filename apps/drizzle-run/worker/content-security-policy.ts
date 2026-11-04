/**
 * App page content security policy
 *
 * Keeps an app page from sending data anywhere but Drizzle Run and the Drizzle docs. An agent's chat
 * reply, a project's output, or a diagram's styles cannot load an image, font, or media from another
 * site, except GitHub's avatar host for Community cards (it serves only GitHub's own images). Page
 * scripts can reach only this origin (the API, runtime assets, and the AI chat relay socket) and
 * orm.drizzle.team (the guided chat's `read_docs`). Analytics uses a same-origin relay.
 * Data and blob URLs stay allowed: they carry what
 * the page already holds. Scripts, styles, and workers are left as they are, since the runtime
 * compiles wasm and the editor injects styles; the chat never renders raw HTML. Only Drizzle Run
 * itself may frame an app page.
 */
export function createAppContentSecurityPolicy(pageUrl: URL): string {
  return [...listResourceDirectives(pageUrl), "frame-ancestors 'self'"].join("; ");
}

/**
 * Embed page content security policy
 *
 * The app page policy's resource limits, for a shared project or an official example drawn inside
 * another site. Any site may frame it, since that is what an embed is for.
 */
export function createEmbedContentSecurityPolicy(pageUrl: URL): string {
  return listResourceDirectives(pageUrl).join("; ");
}

function listResourceDirectives(pageUrl: URL): string[] {
  // Some WebKit versions leave WebSocket schemes out of CSP 'self', so the relay's own socket origin is listed.
  const socketOrigin = `${pageUrl.protocol === "https:" ? "wss:" : "ws:"}//${pageUrl.host}`;

  return [
    "img-src 'self' data: blob: https://avatars.githubusercontent.com",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${socketOrigin} https://orm.drizzle.team data: blob:`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];
}
