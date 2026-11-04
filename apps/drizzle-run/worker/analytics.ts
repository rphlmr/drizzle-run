import { createApiError } from "./http";

/** Relay analytics through the page's origin so image beacons and POSTs work under COEP. */
export async function relayAnalytics(request: Request): Promise<Response> {
  const pageUrl = new URL(request.url);

  if (pageUrl.origin !== "https://drizzle.run") {
    return createApiError(404, "analytics_unavailable", "Analytics is available only on drizzle.run.");
  }

  const collectorUrl = new URL("https://collector.onedollarstats.com/events");
  collectorUrl.search = pageUrl.search;
  const headers = new Headers();

  for (const name of ["content-type", "user-agent", "referer"]) {
    const value = request.headers.get(name);

    if (value !== null) {
      headers.set(name, value);
    }
  }

  const clientAddress = request.headers.get("cf-connecting-ip");

  if (clientAddress !== null) {
    headers.set("X-Forwarded-For", clientAddress);
  }

  const upstream = await fetch(collectorUrl, {
    method: request.method,
    headers,
    body: request.method === "POST" ? await request.arrayBuffer() : undefined,
    redirect: "manual",
    signal: request.signal,
  });
  const responseHeaders = new Headers({
    "Cache-Control": "no-store",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
  });
  const contentType = upstream.headers.get("content-type");

  if (contentType !== null) {
    responseHeaders.set("Content-Type", contentType);
  }

  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}
