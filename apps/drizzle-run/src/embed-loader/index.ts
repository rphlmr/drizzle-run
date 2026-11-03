import { createActor } from "xstate";
import * as z from "zod/mini";

import type {
  PlaygroundCapabilityDetail,
  PlaygroundErrorDetail,
  PlaygroundReadyDetail,
  PlaygroundRunSettledDetail,
} from "./events.js";
import {
  createEmbedMachine,
  isUnavailableCode,
  type EmbedMachineEvent,
  type EmbedUnavailableCode,
  type EmbedUnsupportedStatus,
} from "./machine.js";
import { palette, paletteProperties } from "./palette.js";
import {
  EMBED_PREVIEW_LIMITS,
  EMBED_PROTOCOL,
  EMBED_PROTOCOL_VERSION,
  getEmbedFramePath,
  getEmbedPlaygroundPath,
  parseEmbedFrameMessage,
  parseEmbedHelloMessage,
  readEmbedTarget,
  type EmbedConnectMessage,
  type EmbedFrameMessage,
  type EmbedTarget,
} from "./protocol.js";

export type {
  PlaygroundCapabilityDetail,
  PlaygroundErrorDetail,
  PlaygroundReadyDetail,
  PlaygroundRunSettledDetail,
} from "./events.js";

export {
  EMBED_MAX_RUN_DISPLAYS_BYTES,
  EMBED_MAX_RUN_ERROR_LENGTH,
  EMBED_PREVIEW_LIMITS,
  EMBED_PROTOCOL,
  EMBED_PROTOCOL_VERSION,
  parseEmbedConnectMessage,
  parseEmbedFrameMessage,
  parseEmbedHelloMessage,
  type EmbedCapabilityStatus,
  type EmbedConnectMessage,
  type EmbedFrameErrorCode,
  type EmbedFrameMessage,
  type EmbedHelloMessage,
  type EmbedJsonValue,
  type EmbedNonce,
  type EmbedRunDisplay,
  type EmbedRunSummary,
  type EmbedTarget,
} from "./protocol.js";

/**
 * The loaded playground's height in CSS pixels, when neither the `height` option nor a container height sets one
 *
 * It fits a one-version playground's editor and output; anything taller scrolls inside.
 */
export const EMBED_DEFAULT_HEIGHT = 585;

/**
 * What the click-to-load cover shows before the click: the playground's title and a short description
 *
 * The host page passes it with the snapshot id (Drizzle Run's embed code includes it), so nothing is fetched before
 * the click. Its text is shown as text, never as markup, and {@link EMBED_PREVIEW_LIMITS} caps each field.
 */
export type PlaygroundPreview = {
  title: string;
  description?: string;
  /** What the playground runs on: one side, or both sides of a side-by-side playground. */
  runtime?: readonly [PlaygroundRuntime] | readonly [PlaygroundRuntime, PlaygroundRuntime];
  /** The GitHub login of the shared playground's author, without "@". Official examples show "Official example". */
  author?: string;
};

/**
 * One side of a playground: its `drizzle-orm` version, such as "0.45.4", its database, such as "SQLite", and, for a
 * side of a side-by-side playground, the name its author gave it, such as "Classic".
 */
export type PlaygroundRuntime = {
  name?: string;
  drizzleOrm: string;
  database: string;
};

/** The events a mounted playground dispatches, each a `CustomEvent` with its detail. */
export interface MountedPlaygroundEventMap {
  ready: CustomEvent<PlaygroundReadyDetail>;
  capability: CustomEvent<PlaygroundCapabilityDetail>;
  error: CustomEvent<PlaygroundErrorDetail>;
  "run-settled": CustomEvent<PlaygroundRunSettledDetail>;
}

/** The host callbacks of {@link mountPlayground}, called with each event's detail before its event listeners. */
export type PlaygroundEventCallbacks = {
  onReady?(detail: PlaygroundReadyDetail): void;
  onCapability?(detail: PlaygroundCapabilityDetail): void;
  onError?(detail: PlaygroundErrorDetail): void;
  onRunSettled?(detail: PlaygroundRunSettledDetail): void;
};

/**
 * Options for {@link mountPlayground}
 *
 * Pass `snapshotId` for a shared link, or `example` for an official example, with `step` for one step of its guide.
 */
export type MountPlaygroundOptions = (
  | {
      /** The shared snapshot to open: 1 to 128 letters, numbers, underscores, or hyphens. */
      snapshotId: string;
      example?: never;
      step?: never;
    }
  | {
      /** The official example to open, by slug, such as `"transactions"`. */
      example: string;
      /** A step of the example's guide to open, by step id, such as `"02-savepoint"`. */
      step?: string;
      snapshotId?: never;
    }
) & {
  /** Drizzle Run's HTTP(S) origin, for example `https://run.example.com`. */
  baseUrl: string | URL;
  /** The title and description the cover shows before the click. */
  preview: PlaygroundPreview;
  /**
   * The playground's height in CSS pixels once the reader clicks, {@link EMBED_DEFAULT_HEIGHT} by default. A height on
   * the container wins.
   */
  height?: number;
  /**
   * The embed's colors, cover and playground alike. Without it the cover is dark, the loader's other states follow the
   * host page's `color-scheme`, and the playground follows the reader's system setting.
   */
  theme?: PlaygroundTheme;
} & PlaygroundEventCallbacks;

/** The color theme a host can pick for {@link mountPlayground}. */
export type PlaygroundTheme = "light" | "dark";

/**
 * A mounted loader, returned by {@link mountPlayground}
 *
 * An `EventTarget` that dispatches `ready`, `capability`, `error` and `run-settled`, typed by
 * {@link MountedPlaygroundEventMap}. A listener that throws is reported and does not stop the loader.
 */
export interface MountedPlayground extends EventTarget {
  /** Remove the loader and its frame, and put the element's original content back. Safe to call twice. */
  dispose(): void;
  addEventListener<Type extends keyof MountedPlaygroundEventMap>(
    type: Type,
    listener: (event: MountedPlaygroundEventMap[Type]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<Type extends keyof MountedPlaygroundEventMap>(
    type: Type,
    listener: (event: MountedPlaygroundEventMap[Type]) => void,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void;
}

function toAppOrigin(baseUrl: string | URL): URL {
  let url: URL;

  // The messages leave out the received value: a rejected URL may carry credentials.
  try {
    url = new URL(baseUrl.toString());
  } catch (cause) {
    throw new TypeError("Expected baseUrl to be an absolute Drizzle Run origin, such as 'https://run.example.com'.", {
      cause,
    });
  }

  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError(
      "Expected baseUrl to be an HTTP(S) origin without credentials, path, query, or fragment, such as 'https://run.example.com'.",
    );
  }

  return url;
}

function createPreviewTextSchema(maxLength: number) {
  return z.string().check(
    z.refine((text) => text.trim() !== ""),
    z.maxLength(maxLength),
  );
}
const PlaygroundRuntimeSchema = z.object({
  name: z.optional(createPreviewTextSchema(EMBED_PREVIEW_LIMITS.runtimeTextLength)),
  drizzleOrm: createPreviewTextSchema(EMBED_PREVIEW_LIMITS.runtimeTextLength),
  database: createPreviewTextSchema(EMBED_PREVIEW_LIMITS.runtimeTextLength),
});
const PlaygroundPreviewSchema = z.object({
  title: createPreviewTextSchema(EMBED_PREVIEW_LIMITS.titleLength),
  description: z.optional(createPreviewTextSchema(EMBED_PREVIEW_LIMITS.descriptionLength)),
  runtime: z.optional(
    z.union([z.tuple([PlaygroundRuntimeSchema]), z.tuple([PlaygroundRuntimeSchema, PlaygroundRuntimeSchema])]),
  ),
  author: z.optional(z.string().check(z.regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/))),
}) satisfies z.ZodMiniType<PlaygroundPreview>;
const EmbedHeightSchema = z.optional(z.int().check(z.minimum(1)));

/** Checks a host-supplied preview; its text is only ever set as text, never as markup. */
function assertPlaygroundPreview(preview: unknown): asserts preview is PlaygroundPreview {
  if (!PlaygroundPreviewSchema.safeParse(preview).success) {
    throw new TypeError(
      `Expected preview to be { title, description?, runtime?, author? }: a title and description of at most ${EMBED_PREVIEW_LIMITS.titleLength} and ${EMBED_PREVIEW_LIMITS.descriptionLength} characters, one or two { drizzleOrm, database } of at most ${EMBED_PREVIEW_LIMITS.runtimeTextLength} each, and a GitHub login.`,
    );
  }
}

/** Reads the playground's height once loaded; throws a `TypeError` for one that is not a positive whole number. */
function toEmbedHeight(height: unknown): number {
  const parsed = EmbedHeightSchema.safeParse(height);

  if (!parsed.success) {
    throw new TypeError(
      `Expected height to be a positive whole number of CSS pixels, such as 600, but got ${String(height)}.`,
    );
  }

  return parsed.data ?? EMBED_DEFAULT_HEIGHT;
}

const PlaygroundThemeSchema = z.optional(z.enum(["light", "dark"])) satisfies z.ZodMiniType<
  PlaygroundTheme | undefined
>;

/** Reads the embed's theme; throws a `TypeError` for anything but "light", "dark" or nothing. */
function toPlaygroundTheme(theme: unknown): PlaygroundTheme | undefined {
  const parsed = PlaygroundThemeSchema.safeParse(theme);

  if (!parsed.success) {
    throw new TypeError(`Expected theme to be "light" or "dark", but got ${String(theme)}.`);
  }

  return parsed.data;
}

/** A fresh handshake nonce, or `null` when the browser cannot make random values. */
function resolveNonce(view: Window): string | null {
  const bytes = new Uint8Array(16);

  try {
    view.crypto.getRandomValues(bytes);
  } catch {
    return null;
  }

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createConnectMessage(nonce: string, target: EmbedTarget): EmbedConnectMessage {
  return {
    protocol: EMBED_PROTOCOL,
    version: EMBED_PROTOCOL_VERSION,
    kind: "connect",
    nonce,
    ...target,
  };
}

/** Reads what the options open; throws a `TypeError` when neither a snapshot id nor an example is valid. */
function toEmbedTarget(options: MountPlaygroundOptions): EmbedTarget {
  const target = readEmbedTarget(options);

  if (target === null) {
    const { snapshotId, example, step } = options;
    throw new TypeError(
      `Expected a snapshotId, or an example and optional step, but got ${JSON.stringify({ snapshotId, example, step })}.`,
    );
  }

  return target;
}

// Adopted as a constructable sheet, which a host CSP without 'unsafe-inline' still allows.
// A percentage height resolves only against a definite height, so a min-height and max-height of 100% let a
// container height win over the playground's, and without one the embed keeps it. The cover takes the same box, so
// the page does not shift on the click. Without a theme the cover stays dark and the other states follow the host.
function createStyles(height: number, theme: PlaygroundTheme | undefined): string {
  const statePalette =
    theme === undefined
      ? `.panel{${paletteProperties((token) => palette.light[token])}}
@supports (color:light-dark(#000,#fff)){.panel{${paletteProperties((token) => `light-dark(${palette.light[token]},${palette.dark[token]})`)}}}
@supports not (color:light-dark(#000,#fff)){@media (prefers-color-scheme:dark){.panel{${paletteProperties((token) => palette.dark[token])}}}}`
      : `.panel{${paletteProperties((token) => palette[theme][token])}}`;
  const coverTheme = theme ?? "dark";

  return `:host{all:initial;color-scheme:${theme ?? "inherit"};display:block;position:relative;width:100%;height:100%;container-type:inline-size}
${statePalette}
.cover{${paletteProperties((token) => palette[coverTheme][token])}color-scheme:${coverTheme}}
.cover,.panel{box-sizing:border-box;height:${height}px;min-height:100%;max-height:100%;border-radius:16px;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;text-align:left;-webkit-font-smoothing:antialiased}
.panel{display:flex;flex-direction:column;overflow:hidden;border:1.5px solid var(--card-border);background:var(--surface);box-shadow:3px 3px 0 var(--card-border);color:var(--text)}
.head{display:flex;align-items:center;gap:8px;min-width:0;padding:10px 14px;border-bottom:1px solid var(--border);font-size:13px;color:var(--text-muted)}
.logo{flex:none;display:flex;align-items:center;gap:6px;font-weight:800;font-size:14px;letter-spacing:-0.02em;color:var(--text)}
.wordmark-run{padding:0 4px;border-radius:3px;background:var(--lime);color:var(--on-lime)}
.tile{flex:none;box-sizing:border-box;width:22px;height:22px;display:grid;place-items:center;border:1.5px solid var(--card-border);border-radius:6px;background:var(--lime);box-shadow:2px 2px 0 var(--card-border)}
.tile svg{width:14px;height:7px}
.body{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:18px;text-align:center}
.foot{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:14px;background:var(--surface-2)}
p,h2{margin:0}
h2{font-size:20px;line-height:1.2;font-weight:700}
.panel p{max-width:460px;color:var(--text-muted)}
button,.cta{box-sizing:border-box;margin:0;display:inline-flex;align-items:center;gap:8px;min-height:40px;padding:0 16px;border:1.5px solid var(--run-border);border-radius:10px;background:var(--lime);color:var(--on-lime);font:inherit;font-weight:600;text-decoration:none;cursor:pointer}
.foot a{font-size:13px;font-weight:600;color:var(--text)}
:focus-visible{outline:2px solid var(--accent-text);outline-offset:2px}
.cover{display:flex;flex-direction:column;gap:clamp(14px,2.4cqi,20px);overflow:hidden;padding:clamp(16px,3.4cqi,40px);border:1.5px solid var(--border);background:radial-gradient(circle,color-mix(in srgb,var(--text-muted) 40%,transparent) 1px,transparent 1.5px) 0 0/18px 18px,var(--bg);color:var(--text)}
.cover-head{flex:none;display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}
.cover .logo{gap:8px;font-size:clamp(16px,1.3cqi,20px)}
.cover .tile{width:clamp(26px,2cqi,32px);height:clamp(26px,2cqi,32px);border-radius:7px}
.cover .tile svg{width:60%;height:auto}
.byline{min-width:0;overflow:hidden;padding:3px 12px;border:1px solid var(--border);border-radius:999px;background:var(--surface);color:var(--text-muted);font-size:clamp(12px,1cqi,14px);font-weight:600;text-overflow:ellipsis;white-space:nowrap}
.byline.official{border:1.5px solid var(--run-border);background:var(--lime);color:var(--on-lime)}
.intro{flex:0 1 auto;min-height:0;overflow:hidden;margin-top:clamp(4px,3cqi,32px)}
.cover h2{font-size:clamp(24px,4.4cqi,64px);line-height:1.1;letter-spacing:-0.025em}
.cover h2,.description{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;overflow-wrap:anywhere}
.description{margin:clamp(8px,1.2cqi,16px) 0 0;max-width:46em;color:var(--text-muted);font-size:clamp(15px,1.6cqi,22px);line-height:1.5}
.cover .load{box-sizing:border-box;display:flex;align-items:center;flex:none;width:100%;min-height:0;margin-top:auto;gap:14px;padding:clamp(12px,1.6cqi,18px) clamp(14px,2cqi,24px);border:2px dashed color-mix(in srgb,var(--text-muted) 55%,transparent);border-radius:16px;background:var(--surface);color:var(--text);font-size:clamp(16px,1.4cqi,20px);font-weight:700;text-align:left}
.cover button.load:hover{border-style:solid;border-color:var(--run-border)}
.load-label{flex:none}
.runtime{min-width:0;margin-left:auto;display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:6px;color:var(--text-muted)}
.runtime svg{flex:none;width:14px;height:14px}
.chip{padding:2px 10px;border:1px solid var(--border);border-radius:999px;background:var(--bg);color:var(--text-muted);font-size:12px;font-weight:600;white-space:nowrap}
.version{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--text)}
.play{flex:none;box-sizing:border-box;width:clamp(44px,3.2cqi,56px);height:clamp(44px,3.2cqi,56px);display:grid;place-items:center;border:2px solid var(--run-border);border-radius:12px;background:var(--lime);color:var(--on-lime);box-shadow:3px 3px 0 var(--run-border)}
.play svg{width:45%;height:45%}
.cover :focus-visible{outline-offset:4px}
.cover.over-frame{position:absolute;inset:0}
.play.loading svg{animation:spin .9s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.play.loading svg{animation-duration:2.4s}}
@container (min-width:900px){.intro{margin:auto auto 0;max-width:min(100%,1100px);text-align:center}.description{margin-inline:auto}.cover .load{width:auto;min-width:min(100%,560px);margin:clamp(16px,2cqi,32px) auto auto;gap:18px}.runtime{margin-left:clamp(16px,2cqi,40px)}.chip{font-size:13px}}
@container (max-width:479px){.cover .load{flex-wrap:wrap}.runtime{flex-basis:100%;justify-content:flex-start;margin-left:58px}}
`;
}

const fallbackCopy = {
  embedding_context_unsupported: {
    title: "Open this playground in a new tab",
    message:
      "This website doesn't give embedded playgrounds the isolation they need. Your browser is fine, so it will run in its own tab.",
  },
  browser_unsupported: {
    title: "This browser can't run the playground",
    message:
      "It's missing features Drizzle Run needs. Try a current version of Chrome or Firefox, or Safari 26 or later.",
  },
} satisfies Record<EmbedUnsupportedStatus, { title: string; message: string }>;

const unavailableCopy = {
  not_found: {
    title: "This playground no longer exists",
    message: "It may have been removed, or this page's embed code may point to the wrong playground.",
  },
  unopenable: {
    title: "This playground can't open here",
    message: "Open it in Drizzle Run to see why.",
  },
  unsupported_host: {
    title: "This page can't load playgrounds",
    message:
      "Drizzle Run embeds need a page served over HTTP(S). A page opened from a file or a sandbox can't load one.",
  },
} satisfies Record<EmbedUnavailableCode, { title: string; message: string }>;

/** The machine event for a frame lifecycle message, or `null` for one the loader ignores */
function toMachineEvent(message: EmbedFrameMessage): EmbedMachineEvent | null {
  switch (message.kind) {
    case "ready": {
      return { type: "embed.frame.ready", nonce: message.nonce };
    }
    case "capability": {
      return { type: "embed.frame.capability", nonce: message.nonce, status: message.status };
    }
    case "error": {
      return { type: "embed.frame.error", nonce: message.nonce, code: message.code };
    }
    case "run-settled": {
      return { type: "embed.frame.run.settled", nonce: message.nonce, run: message.run };
    }
    default: {
      return null;
    }
  }
}

const svgNamespace = "http://www.w3.org/2000/svg";
// The four bars of the Drizzle mark, in its 317 by 166 viewBox.
const drizzleMark = "M59 74 14 151.5M155 14 110 92M207 74 162 151.5M303 14.5 258 92";

/**
 * Mount a click-to-load Drizzle Run playground
 *
 * Replaces the element's content with a cover in an open shadow root: the playground's title and description, at the
 * playground's height. Nothing loads until the reader clicks; then an iframe of the same height opens the snapshot or
 * example, in the chosen theme, and authenticates its handshake by origin and nonce.
 *
 * Throws a `TypeError` for an invalid snapshot id, example, step, base URL, preview, or height, and for an element
 * outside a document with a window.
 *
 * @example
 * const playground = mountPlayground(element, {
 *   snapshotId: "abc123",
 *   baseUrl: "https://run.example.com",
 *   height: 600,
 *   preview: { title: "Users", description: "Drizzle ORM 0.45.4 on SQLite" },
 * });
 * playground.dispose();
 */
export function mountPlayground(element: HTMLElement, options: MountPlaygroundOptions): MountedPlayground {
  const target = toEmbedTarget(options);
  const appOrigin = toAppOrigin(options.baseUrl);
  const { preview } = options;

  assertPlaygroundPreview(preview);
  const height = toEmbedHeight(options.height);
  const theme = toPlaygroundTheme(options.theme);
  const styles = createStyles(height, theme);

  const document = element.ownerDocument;
  const browserWindow = document.defaultView;

  if (browserWindow === null) {
    throw new TypeError("Expected the embed element to belong to a document with a window, but it has none.");
  }

  // Keep the host content to restore on dispose
  const originalContent = document.createDocumentFragment();
  let hostState: "mounted" | "restored" = "mounted";

  while (element.firstChild !== null) {
    originalContent.append(element.firstChild);
  }

  // Attach the shadow root
  // The class and data attribute are public hooks for host layout; everything else is in the shadow root.
  const root = document.createElement("div");
  root.className = "drizzle-run-embed";
  root.setAttribute("data-drizzle-run-embed", "");
  const shadow = root.attachShadow({ mode: "open" });

  // Browsers without constructable sheets get a <style> element, which a strict CSP blocks.
  let fallbackStyle: HTMLStyleElement | undefined;

  if (typeof browserWindow.CSSStyleSheet === "function" && "adoptedStyleSheets" in shadow) {
    const sheet = new browserWindow.CSSStyleSheet();
    sheet.replaceSync(styles);
    shadow.adoptedStyleSheets = [sheet];
  } else {
    fallbackStyle = document.createElement("style");
    fallbackStyle.textContent = styles;
  }

  const showNodes = (...nodes: Node[]): void => {
    if (hostState === "restored") {
      return;
    }

    shadow.replaceChildren(...(fallbackStyle ? [fallbackStyle] : []), ...nodes);
  };
  element.replaceChildren(root);

  // The handle is the event target; the option callbacks are its first listeners
  const handle: MountedPlayground = Object.assign(new EventTarget(), { dispose });
  const notify = <Type extends keyof MountedPlaygroundEventMap>(
    type: Type,
    detail: MountedPlaygroundEventMap[Type]["detail"],
  ): void => {
    if (hostState === "restored") {
      return;
    }

    handle.dispatchEvent(new CustomEvent(type, { detail }));
  };
  handle.addEventListener("ready", (event) => options.onReady?.(event.detail));
  handle.addEventListener("capability", (event) => options.onCapability?.(event.detail));
  handle.addEventListener("error", (event) => options.onError?.(event.detail));
  handle.addEventListener("run-settled", (event) => options.onRunSettled?.(event.detail));

  let iframe: HTMLIFrameElement | undefined;
  let loadingCover: HTMLDivElement | undefined;

  const sendLoad = (type: "embed.load.activate" | "embed.load.retry"): void => {
    loader.send({ type, nonce: resolveNonce(browserWindow) });
  };

  /** An inline SVG icon: a strict host CSP that blocks data: images still draws it. */
  const createIcon = (viewBox: string, pathAttributes: Record<string, string>): SVGSVGElement => {
    const svg = document.createElementNS(svgNamespace, "svg");
    svg.setAttribute("viewBox", viewBox);
    svg.setAttribute("aria-hidden", "true");
    const shape = document.createElementNS(svgNamespace, "path");

    for (const [name, value] of Object.entries(pathAttributes)) {
      shape.setAttribute(name, value);
    }

    svg.append(shape);

    return svg;
  };

  /** The Drizzle Run wordmark: the lime tile with the Drizzle mark, then "Drizzle" and "Run" on lime. */
  const createLogo = (): HTMLSpanElement => {
    const logo = document.createElement("span");
    logo.className = "logo";
    const tile = document.createElement("span");
    tile.className = "tile";
    tile.append(
      createIcon("0 0 317 166", {
        d: drizzleMark,
        stroke: "#0a0a0a",
        "stroke-width": "30",
        "stroke-linecap": "round",
        fill: "none",
      }),
    );
    const run = document.createElement("span");
    run.className = "wordmark-run";
    run.textContent = "Run";
    logo.append(tile, "Drizzle", run);

    return logo;
  };

  /** Every state after the click is the same card: the Drizzle Run wordmark over its content. */
  const createCard = (...sections: HTMLElement[]): HTMLDivElement => {
    const panel = document.createElement("div");
    panel.className = "panel";
    panel.append(createSection("head", createLogo()), ...sections);

    return panel;
  };

  const createSection = (className: string, ...nodes: Node[]): HTMLDivElement => {
    const sectionElement = document.createElement("div");
    sectionElement.className = className;
    sectionElement.append(...nodes);

    return sectionElement;
  };

  const createTextElement = <Tag extends keyof HTMLElementTagNameMap>(
    tag: Tag,
    content: string,
  ): HTMLElementTagNameMap[Tag] => {
    const node = document.createElement(tag);
    node.textContent = content;

    return node;
  };

  const createTextSpan = (className: string, content: string): HTMLSpanElement => {
    const span = createTextElement("span", content);
    span.className = className;

    return span;
  };

  /**
   * What the playground runs on, as chips: the version and database of one side, or both sides' names and versions
   * with a side-by-side mark between them, each with its database when the two differ.
   */
  const createRuntime = (runtime: NonNullable<PlaygroundPreview["runtime"]>): HTMLSpanElement => {
    const [first, second] = runtime;
    const chips = createTextSpan("runtime", "");
    const toVersionText = (side: PlaygroundRuntime) =>
      side.name === undefined ? side.drizzleOrm : `${side.name} · ${side.drizzleOrm}`;

    if (second === undefined) {
      chips.append(createTextSpan("chip version", toVersionText(first)), createTextSpan("chip", first.database));

      return chips;
    }

    const between = createIcon("0 0 24 24", {
      d: "M4 8h15m-4-4 4 4-4 4M20 16H5m4-4-4 4 4 4",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "2",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    });

    if (first.database === second.database) {
      chips.append(
        createTextSpan("chip version", toVersionText(first)),
        between,
        createTextSpan("chip version", toVersionText(second)),
        createTextSpan("chip", first.database),
      );

      return chips;
    }

    chips.append(
      createTextSpan("chip version", `${toVersionText(first)} · ${first.database}`),
      between,
      createTextSpan("chip version", `${toVersionText(second)} · ${second.database}`),
    );

    return chips;
  };

  /** Who the playground comes from: Drizzle for an official example, else its author when the host names one. */
  const createByline = (): HTMLSpanElement => {
    if ("example" in target) {
      const byline = createTextElement("span", "Official example");
      byline.className = "byline official";

      return byline;
    }

    const byline = createTextElement(
      "span",
      preview.author === undefined ? "Shared playground" : `by @${preview.author}`,
    );
    byline.className = "byline";

    return byline;
  };

  /**
   * The cover in the playground's box: the wordmark and byline, the title and description, and a card at the bottom
   * that loads the playground. While it loads, the card says so in place of the button, and the cover lies over the
   * hidden frame so the box never empties.
   */
  const createCover = (phase: "dormant" | "loading"): HTMLDivElement => {
    const title = createTextElement("h2", preview.title);
    title.title = preview.title;
    const intro = createSection("intro", title);

    if (preview.description !== undefined) {
      const description = createTextElement("p", preview.description);
      description.className = "description";
      intro.append(description);
    }

    const load = phase === "dormant" ? document.createElement("button") : document.createElement("div");
    load.className = "load";

    if (phase === "dormant") {
      const playTile = createSection("play", createIcon("0 0 24 24", { d: "M7 5l12 7-12 7z", fill: "currentColor" }));
      load.append(playTile, createTextSpan("load-label", "Load playground"));
      load.setAttribute("type", "button");
      load.setAttribute("aria-label", "Load playground in Drizzle Run");
      load.addEventListener("click", () => sendLoad("embed.load.activate"));
    } else {
      const spinner = createIcon("0 0 24 24", {
        d: "M12 3a9 9 0 1 0 9 9",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "3",
        "stroke-linecap": "round",
      });
      const label = createTextSpan("load-label", "Loading Drizzle Run…");
      label.setAttribute("role", "status");
      label.setAttribute("aria-live", "polite");
      load.append(createSection("play loading", spinner), label);
    }

    if (preview.runtime !== undefined) {
      load.append(createRuntime(preview.runtime));
    }

    return createSection(
      phase === "dormant" ? "cover" : "cover over-frame",
      createSection("cover-head", createLogo(), createByline()),
      intro,
      load,
    );
  };

  const showDormant = (): void => {
    showNodes(createCover("dormant"));
  };

  /** Shows the frame under the loading cover until it reports ready, and reports its load failure under the attempt's nonce. */
  const openFrame = (nonce: string): void => {
    const frame = document.createElement("iframe");
    frame.title = "Drizzle Run playground";
    frame.allow = "cross-origin-isolated";
    frame.referrerPolicy = "no-referrer";
    // Inline, so the frame keeps its box even if the shadow sheet never applies.
    frame.style.display = "block";
    frame.style.width = "100%";
    frame.style.border = "0";
    // A container height wins over the playground's, as for the panels.
    frame.style.height = `${height}px`;
    frame.style.minHeight = "100%";
    frame.style.maxHeight = "100%";
    frame.setAttribute("data-drizzle-run-frame", "");
    const frameUrl = new URL(getEmbedFramePath(target), appOrigin);
    frameUrl.hash = new URLSearchParams({ nonce }).toString();

    if (theme !== undefined) {
      frameUrl.searchParams.set("theme", theme);
    }

    frame.setAttribute("src", frameUrl.href);
    frame.addEventListener("error", () => loader.send({ type: "embed.frame.error", nonce, code: "frame_load" }));
    iframe = frame;

    // The frame renders under the cover rather than hidden: browsers skip rendering a hidden cross-origin frame, so
    // it would only start painting once revealed.
    loadingCover = createCover("loading");
    loadingCover.setAttribute("data-loading", "");

    showNodes(frame, loadingCover);
  };

  const revealFrame = (): void => {
    loadingCover?.remove();
    loadingCover = undefined;
  };

  const removeFrame = (): void => {
    iframe?.removeAttribute("src");
    iframe?.remove();
    iframe = undefined;
    loadingCover = undefined;
  };

  const showFailure = (code: PlaygroundErrorDetail["code"]): void => {
    const link = document.createElement("a");
    link.href = new URL(getEmbedPlaygroundPath(target), appOrigin).href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Open in Drizzle Run ↗";

    if (isUnavailableCode(code)) {
      const copy = unavailableCopy[code];
      const body = createSection("body", createTextElement("h2", copy.title), createTextElement("p", copy.message));

      if (code === "not_found") {
        link.href = new URL("/examples", appOrigin).href;
        link.textContent = "Browse examples ↗";
      }

      const panel = createCard(body, createSection("foot", link));
      panel.setAttribute("role", "alert");
      showNodes(panel);
      return;
    }

    const message = document.createElement("p");
    message.textContent = "Drizzle Run could not load this playground. Check your connection and retry.";

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Retry loading";
    button.addEventListener("click", () => sendLoad("embed.load.retry"));

    const panel = createCard(createSection("body", message), createSection("foot", button, link));
    panel.setAttribute("role", "alert");
    showNodes(panel);
  };

  const showUnsupported = (status: EmbedUnsupportedStatus): void => {
    const copy = fallbackCopy[status];
    const title = document.createElement("h2");
    title.textContent = copy.title;
    const message = document.createElement("p");
    message.textContent = copy.message;
    const body = createSection("body", title, message);

    if (status === "embedding_context_unsupported") {
      const link = document.createElement("a");
      link.className = "cta";
      link.href = new URL(getEmbedPlaygroundPath(target), appOrigin).href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Open in a new tab ↗";
      body.append(link);
    }

    const panel = createCard(body);
    panel.setAttribute("role", "alert");
    showNodes(panel);
  };

  const handleFrameMessage = (event: MessageEvent<unknown>): void => {
    const frameWindow = iframe?.contentWindow;

    if (frameWindow === undefined || frameWindow === null || event.source !== frameWindow) {
      return;
    }

    if (event.origin !== appOrigin.origin) {
      return;
    }

    const hello = parseEmbedHelloMessage(event.data);

    if (hello !== null) {
      loader.send({ type: "embed.frame.hello", nonce: hello.nonce });
      return;
    }

    const message = parseEmbedFrameMessage(event.data);
    const machineEvent = message === null ? null : toMachineEvent(message);

    if (machineEvent !== null) {
      loader.send(machineEvent);
    }
  };

  const restoreHost = (): void => {
    if (hostState === "restored") {
      return;
    }

    hostState = "restored";
    browserWindow.removeEventListener("message", handleFrameMessage);
    removeFrame();
    shadow.replaceChildren();
    element.replaceChildren(originalContent);
  };

  // Start the loader machine with the views and host events
  const loaderLogic = createEmbedMachine({
    showDormant,
    openFrame,
    connectFrame: (nonce) => iframe?.contentWindow?.postMessage(createConnectMessage(nonce, target), appOrigin.origin),
    revealFrame,
    removeFrame,
    showFailure,
    showUnsupported,
    notifyReady: (detail) => notify("ready", detail),
    notifyCapability: (detail) => notify("capability", detail),
    notifyError: (detail) => notify("error", detail),
    notifyRunSettled: (run) => notify("run-settled", run),
    restoreHost,
  });
  const loader = createActor(loaderLogic, {
    input: { hostOrigin: browserWindow.origin === "null" ? "opaque" : "tuple" },
    clock: {
      setTimeout: (callback, delayMs) => browserWindow.setTimeout(callback, delayMs),
      clearTimeout: (timeoutId) => browserWindow.clearTimeout(timeoutId),
    },
  });

  browserWindow.addEventListener("message", handleFrameMessage);
  loader.start();

  function dispose(): void {
    restoreHost();
    loader.send({ type: "embed.dispose" });
  }

  return handle;
}
