import type { ConnectRelayEnvironment } from "./connect-platform";

/** The subset of a D1 result the worker reads. */
export interface D1Result<Row = unknown> {
  results?: Row[];
  meta?: { changes?: number };
}

/** The subset of a D1 prepared statement the worker uses. */
export interface D1PreparedStatement {
  bind(...values: (string | number | null)[]): D1PreparedStatement;
  first<Row = unknown>(columnName?: string): Promise<Row | null>;
  run<Row = unknown>(): Promise<D1Result<Row>>;
  all<Row = unknown>(): Promise<D1Result<Row>>;
  /** The rows as arrays of column values, in column order. Drizzle reads selects this way. */
  raw<Row extends unknown[] = unknown[]>(): Promise<Row[]>;
}

/** The subset of a D1 database the worker uses. */
export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  /** Runs the statements in one transaction. */
  batch<Row = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<Row>[]>;
}

/** The subset of an element `HTMLRewriter` hands to a handler that the worker uses. */
export interface HtmlRewriterElement {
  setInnerContent(content: string): void;
  append(content: string, options?: { html: boolean }): void;
}

/** The subset of the Workers runtime's streaming `HTMLRewriter` the worker uses. */
export interface HtmlRewriter {
  on(selector: string, handlers: { element(element: HtmlRewriterElement): void }): HtmlRewriter;
  transform(response: Response): Response;
}

declare global {
  var HTMLRewriter: new () => HtmlRewriter;
}

/** The subset of an R2 object the worker reads. */
export interface R2ObjectBody {
  body: ReadableStream<Uint8Array>;
  contentType?: string;
  httpEtag: string;
  size: number;
  checksums?: { md5?: ArrayBuffer };
}

/** The subset of an R2 bucket the worker uses. */
export interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
}

/** The subset of an R2 bucket cloud sync uses: one JSON object per project revision. */
export interface CloudProjectBucket {
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  delete(key: string): Promise<void>;
}

/** A Workers rate limit binding. */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** The static assets binding. */
export interface StaticAssetsBinding {
  fetch(request: Request): Promise<Response>;
}

/** The worker's bindings. */
export interface WorkerEnvironment extends ConnectRelayEnvironment {
  PLAYGROUNDS: D1Database;
  RUNTIME_ASSETS: R2Bucket;
  ASSETS: StaticAssetsBinding;
  /** Publishes, Community reports and recorded runs per minute, per account or address. */
  PUBLISH_RATE_LIMIT?: RateLimitBinding;
  /** Bytes every share and recorded run together may keep in D1 in total. Defaults to 400000000 (400 MB). */
  PUBLISH_MAX_STORED_BYTES?: string;
  /** Sign-ins started per minute, per address. */
  AUTH_RATE_LIMIT?: RateLimitBinding;
  /** AI chat connections per minute, per room and address. */
  CONNECT_RATE_LIMIT?: RateLimitBinding;
  /** AI chat connections per minute, per address across all rooms. */
  CONNECT_ADDRESS_RATE_LIMIT?: RateLimitBinding;
  /** The GitHub App's client id. Sign-in is off while it or the secret is missing. */
  GITHUB_CLIENT_ID?: string;
  /** The GitHub App's client secret, set with `wrangler secret put GITHUB_CLIENT_SECRET`. */
  GITHUB_CLIENT_SECRET?: string;
  /** Overrides https://github.com. Set only in the e2e environment, which signs in against a mock. */
  GITHUB_OAUTH_URL?: string;
  /** Overrides https://api.github.com. Set only in the e2e environment, which signs in against a mock. */
  GITHUB_API_URL?: string;
  /** Synced projects, separate from RUNTIME_ASSETS. Cloud sync is off while it is missing. */
  CLOUD_PROJECTS?: CloudProjectBucket;
  /** Each account's cloud save requests per minute. Saves are not rate limited while it is missing. */
  CLOUD_SYNC_RATE_LIMIT?: RateLimitBinding;
  /** `off` on next.drizzle.run and pull request previews, so search engines never index them. */
  SEARCH_INDEXING?: string;
}
