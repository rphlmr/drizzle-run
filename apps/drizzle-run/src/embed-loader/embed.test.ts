import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EMBED_DEFAULT_HEIGHT,
  EMBED_MAX_RUN_DISPLAYS_BYTES,
  EMBED_MAX_RUN_ERROR_LENGTH,
  EMBED_PREVIEW_LIMITS,
  EMBED_PROTOCOL,
  EMBED_PROTOCOL_VERSION,
  mountPlayground,
  type MountPlaygroundOptions,
  type PlaygroundEventCallbacks,
  type PlaygroundPreview,
  type PlaygroundTheme,
} from "./index.js";
import { palette } from "./palette.js";
import {
  EMBED_FRAME_ERROR_CODES,
  getEmbedFramePath,
  getEmbedJsonByteLength,
  getEmbedPlaygroundPath,
  parseEmbedConnectMessage,
  parseEmbedFrameMessage,
  parseEmbedHelloMessage,
} from "./protocol.js";

type Listener = EventListenerOrEventListenerObject;

class FakeFrameWindow {
  readonly messages: Array<{ message: unknown; targetOrigin: string }> = [];

  postMessage(message: unknown, targetOrigin: string): void {
    this.messages.push({ message, targetOrigin });
  }
}

class FakeSheet {
  text = "";

  replaceSync(text: string): void {
    this.text = text;
  }
}

class FakeView {
  static #nextNonce = 0;

  /** Constructable stylesheets; a test deletes it to stand for a browser without them. */
  CSSStyleSheet: typeof FakeSheet | undefined = FakeSheet;

  /** The host page's origin; a test sets `"null"` to stand for a `file://` page or a sandboxed frame. */
  origin = "https://blog.example.test";

  readonly crypto = {
    getRandomValues: (values: Uint8Array): Uint8Array => {
      FakeView.#nextNonce += 1;
      values.fill(FakeView.#nextNonce);
      return values;
    },
  };

  readonly #listeners = new Map<string, Set<Listener>>();
  #nextTimerId = 1;
  readonly #timers = new Map<number, ReturnType<typeof setTimeout>>();

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.#listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.#listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: Event): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      if (typeof listener === "function") {
        listener(event);
      } else {
        listener.handleEvent(event);
      }
    }
  }

  listenerCount(type: string): number {
    return this.#listeners.get(type)?.size ?? 0;
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.#nextTimerId;
    this.#nextTimerId += 1;
    this.#timers.set(id, globalThis.setTimeout(callback, delayMs));

    return id;
  }

  clearTimeout(id: number): void {
    const timer = this.#timers.get(id);

    if (timer === undefined) {
      return;
    }

    globalThis.clearTimeout(timer);
    this.#timers.delete(id);
  }
}

class FakeElement {
  readonly style: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly childNodes: FakeElement[] = [];
  readonly listeners = new Map<string, Set<Listener>>();
  readonly frameWindow: FakeFrameWindow | null;
  ownerDocument: FakeDocument;
  parent: FakeElement | null = null;
  className = "";
  mode = "";
  shadowRoot: FakeElement | null = null;
  adoptedStyleSheets: FakeSheet[] = [];
  #textContent: string | null = "";
  type = "";
  title = "";
  referrerPolicy = "";
  target = "";
  rel = "";
  href = "";

  constructor(
    readonly tagName: string,
    ownerDocument: FakeDocument,
  ) {
    this.ownerDocument = ownerDocument;
    this.frameWindow = tagName === "iframe" ? new FakeFrameWindow() : null;
  }

  get firstChild(): FakeElement | null {
    return this.childNodes[0] ?? null;
  }

  get textContent(): string | null {
    return this.#textContent + this.childNodes.map((child) => child.textContent ?? "").join("");
  }

  set textContent(value: string | null) {
    this.#textContent = value;
    this.replaceChildren();
  }

  attachShadow(init: { mode: "open" | "closed" }): FakeElement {
    const root = new FakeElement("#shadow-root", this.ownerDocument);
    root.mode = init.mode;

    if (init.mode === "open") {
      this.shadowRoot = root;
    }

    return root;
  }

  get contentWindow(): FakeFrameWindow | null {
    return this.frameWindow;
  }

  append(...nodes: Array<FakeElement | FakeFragment | string>): void {
    for (const node of nodes) {
      if (typeof node === "string") {
        const text = new FakeElement("#text", this.ownerDocument);
        text.textContent = node;
        this.append(text);
        continue;
      }

      if (node instanceof FakeFragment) {
        this.append(...node.childNodes.splice(0));
        continue;
      }

      node.remove();
      node.parent = this;
      this.childNodes.push(node);

      if (node.tagName === "iframe") {
        node.ownerDocument.onIframeInsert?.(node);
      }
    }
  }

  replaceChildren(...nodes: Array<FakeElement | FakeFragment>): void {
    for (const child of this.childNodes.splice(0)) {
      child.parent = null;
    }

    this.append(...nodes);
  }

  remove(): void {
    if (this.parent === null) {
      return;
    }

    const index = this.parent.childNodes.indexOf(this);

    if (index >= 0) {
      this.parent.childNodes.splice(index, 1);
    }

    this.parent = null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: Event = new Event(type)): void {
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === "function") {
        listener(event);
      } else {
        listener.handleEvent(event);
      }
    }
  }

  querySelector(selector: string): FakeElement | null {
    for (const child of this.childNodes) {
      if (child.tagName === selector || child.attributes.has(`data-${selector}`)) {
        return child;
      }

      const nested = child.querySelector(selector);

      if (nested !== null) {
        return nested;
      }
    }

    return null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const found: FakeElement[] = [];

    for (const child of this.childNodes) {
      const hasClass = selector.startsWith(".") && child.className.split(" ").includes(selector.slice(1));

      if (child.tagName === selector || hasClass) {
        found.push(child);
      }

      found.push(...child.querySelectorAll(selector));
    }

    return found;
  }
}

class FakeFragment {
  readonly childNodes: FakeElement[] = [];

  append(node: FakeElement): void {
    node.remove();
    node.parent = null;
    this.childNodes.push(node);
  }
}

class FakeDocument {
  readonly view = new FakeView();
  // The fake view implements only the Window members the loader uses.
  readonly defaultView = this.view as unknown as Window;
  readonly head: FakeElement = new FakeElement("head", this);
  readonly adoptedStyleSheets: unknown[] = [];
  onIframeInsert: ((frame: FakeElement) => void) | undefined;

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }

  createElementNS(_namespace: string, tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }

  createDocumentFragment(): FakeFragment {
    return new FakeFragment();
  }
}

const APP_ORIGIN = "https://run.example.com";
const previewFixture = {
  title: "Users",
  description: "Drizzle ORM 0.45.4 on SQLite",
} satisfies PlaygroundPreview;

type TestPlaygroundOptions = {
  document?: FakeDocument;
  snapshotId?: string;
  /** Mounts this official example instead of the snapshot. */
  example?: { example: string; step?: string };
  preview?: PlaygroundPreview;
  height?: number;
  theme?: PlaygroundTheme;
  callbacks?: PlaygroundEventCallbacks;
};

// The fakes implement only what the loader touches, so a cast stands them in for the DOM types.
function asHTMLElement(element: FakeElement): HTMLElement {
  return element as unknown as HTMLElement;
}

function mountTestPlayground({
  document = new FakeDocument(),
  snapshotId = "snapshot_123",
  example,
  preview = previewFixture,
  height,
  theme,
  callbacks = {},
}: TestPlaygroundOptions = {}) {
  const host = new FakeElement("div", document);
  const original = new FakeElement("p", document);
  original.textContent = "host content";
  host.append(original);

  const mountHandle = mountPlayground(asHTMLElement(host), {
    ...(example ?? { snapshotId }),
    baseUrl: APP_ORIGIN,
    preview,
    ...(height === undefined ? {} : { height }),
    ...(theme === undefined ? {} : { theme }),
    ...callbacks,
  });

  return { document, host, original, mountHandle };
}

/** The loader's UI, inside the shadow root of the element it adds to the host. */
function getLoaderRoot(host: FakeElement): FakeElement {
  const shadowRoot = host.firstChild?.shadowRoot;

  if (shadowRoot === null || shadowRoot === undefined) {
    throw new Error("Expected the loader to render inside an open shadow root.");
  }

  return shadowRoot;
}

function getFrame(host: FakeElement): FakeElement {
  const frame = getLoaderRoot(host).querySelector("iframe");

  if (frame === null) {
    throw new Error("Expected the loader to render its iframe.");
  }

  return frame;
}

/** Whether the loading cover is gone from over the frame, so the reader sees the playground. */
function isFrameRevealed(frame: FakeElement): boolean {
  return frame.parent?.querySelector("loading") === null;
}

function getFrameWindow(frame: FakeElement): FakeFrameWindow {
  if (frame.frameWindow === null) {
    throw new Error(`Expected an iframe with a content window, but got a '${frame.tagName}' element.`);
  }

  return frame.frameWindow;
}

function clickLoaderButton(host: FakeElement): void {
  getLoaderRoot(host).querySelector("button")?.dispatch("click");
}

function sendFrameMessage({
  view,
  source,
  origin,
  data,
}: {
  view: FakeView;
  source: FakeFrameWindow;
  origin: string;
  data: unknown;
}): void {
  // The loader reads only these fields of a MessageEvent.
  const event = { source, origin, data } as unknown as MessageEvent<unknown>;
  view.dispatch("message", event);
}

function sendFrameHandshake(view: FakeView, frame: FakeElement): void {
  const frameUrl = frame.getAttribute("src");

  if (frameUrl === null) {
    throw new Error("Expected the iframe URL to be set before its handshake.");
  }

  const nonce = new URLSearchParams(new URL(frameUrl).hash.slice(1)).get("nonce");

  if (nonce === null) {
    throw new Error("Expected the iframe URL to carry its handshake nonce.");
  }

  sendFrameMessage({
    view,
    source: getFrameWindow(frame),
    origin: APP_ORIGIN,
    data: {
      protocol: EMBED_PROTOCOL,
      version: EMBED_PROTOCOL_VERSION,
      kind: "hello",
      nonce,
    },
  });
}

function getConnectMessage(frame: FakeElement): { protocol: string; version: number; kind: string; nonce: string } {
  const sent = frame.frameWindow?.messages[0]?.message;

  if (typeof sent !== "object" || sent === null) {
    throw new Error("Expected the loader to send its connect message.");
  }

  return sent as { protocol: string; version: number; kind: string; nonce: string };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("mountPlayground", () => {
  it("should render the placeholder inside an open shadow root", () => {
    const { host } = mountTestPlayground();
    const root = host.firstChild;

    expect(host.childNodes).toHaveLength(1);
    expect(root?.className).toBe("drizzle-run-embed");
    expect(root?.getAttribute("data-drizzle-run-embed")).toBe("");
    expect(root?.childNodes).toHaveLength(0);
    expect(root?.shadowRoot?.mode).toBe("open");
    expect(getLoaderRoot(host).querySelector("button")?.textContent).toBe("Load playground");
    expect(getLoaderRoot(host).querySelectorAll("svg")).toHaveLength(2);
    expect(getLoaderRoot(host).querySelector("img")).toBeNull();
  });

  it("should show the title and description on the cover before the click, as text only", () => {
    const preview = {
      title: 'Users <img src="x" onerror="alert(1)">',
      description: "<b>Drizzle ORM</b> 1.0.0-rc.5 on PostgreSQL",
    } satisfies PlaygroundPreview;
    const { host } = mountTestPlayground({ preview });
    const root = getLoaderRoot(host);

    expect(root.querySelector("h2")?.textContent).toBe(preview.title);
    expect(root.querySelector("p")?.textContent).toBe(preview.description);
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("b")).toBeNull();
    expect(root.querySelector("iframe")).toBeNull();

    clickLoaderButton(host);

    expect(getLoaderRoot(host).querySelector("iframe")).not.toBeNull();
  });

  it("should name the author of a share, mark an official example, and show what each runs on", () => {
    const shared = getLoaderRoot(
      mountTestPlayground({
        preview: { ...previewFixture, runtime: [{ drizzleOrm: "0.45.4", database: "SQLite" }], author: "octocat" },
      }).host,
    );
    const anonymous = getLoaderRoot(mountTestPlayground({ preview: { title: "Users" } }).host);
    const official = getLoaderRoot(
      mountTestPlayground({ example: { example: "transactions" }, preview: { ...previewFixture, author: "octocat" } })
        .host,
    );

    expect(shared.textContent).toContain("by @octocat");
    expect(shared.querySelectorAll(".chip").map((chip) => chip.textContent)).toEqual(["0.45.4", "SQLite"]);
    expect(anonymous.textContent).toContain("Shared playground");
    expect(anonymous.querySelector("p")).toBeNull();
    expect(official.textContent).toContain("Official example");
    expect(official.textContent).not.toContain("octocat");
  });

  it("should show both releases of a side-by-side playground, with each database only when they differ", () => {
    const readChips = (runtime: NonNullable<PlaygroundPreview["runtime"]>) =>
      getLoaderRoot(mountTestPlayground({ preview: { ...previewFixture, runtime } }).host)
        .querySelectorAll(".chip")
        .map((chip) => chip.textContent);

    expect(
      readChips([
        { drizzleOrm: "0.45.4", database: "PostgreSQL" },
        { drizzleOrm: "1.0.0-rc.5", database: "PostgreSQL" },
      ]),
    ).toEqual(["0.45.4", "1.0.0-rc.5", "PostgreSQL"]);
    expect(
      readChips([
        { drizzleOrm: "0.45.4", database: "PostgreSQL" },
        { drizzleOrm: "1.0.0-rc.5", database: "SQLite" },
      ]),
    ).toEqual(["0.45.4 · PostgreSQL", "1.0.0-rc.5 · SQLite"]);
  });

  it("should reject missing preview data before replacing the host content", () => {
    const document = new FakeDocument();
    const host = new FakeElement("div", document);
    const original = new FakeElement("p", document);
    host.append(original);
    const options = {
      snapshotId: "snapshot_123",
      baseUrl: APP_ORIGIN,
      preview: previewFixture,
    } satisfies MountPlaygroundOptions;
    Reflect.deleteProperty(options, "preview");

    expect(() => mountPlayground(asHTMLElement(host), options)).toThrow(TypeError);
    expect(host.firstChild).toBe(original);
    expect(document.view.listenerCount("message")).toBe(0);
  });

  it("should refuse a malformed preview", () => {
    const sqliteRuntime = { drizzleOrm: "0.45.4", database: "SQLite" };
    const malformed: unknown[] = [
      null,
      {},
      { ...previewFixture, title: undefined },
      { ...previewFixture, title: "" },
      { ...previewFixture, title: "  " },
      { ...previewFixture, title: 1 },
      { ...previewFixture, description: " \n" },
      { ...previewFixture, runtime: "Drizzle ORM 0.45.4" },
      { ...previewFixture, runtime: [] },
      { ...previewFixture, runtime: [sqliteRuntime, sqliteRuntime, sqliteRuntime] },
      { ...previewFixture, runtime: [{ ...sqliteRuntime, database: "" }] },
      {
        ...previewFixture,
        runtime: [{ ...sqliteRuntime, drizzleOrm: "x".repeat(EMBED_PREVIEW_LIMITS.runtimeTextLength + 1) }],
      },
      { ...previewFixture, author: "@octocat" },
      { ...previewFixture, author: "-octocat" },
      { ...previewFixture, author: "x".repeat(40) },
      { ...previewFixture, title: "x".repeat(EMBED_PREVIEW_LIMITS.titleLength + 1) },
      { ...previewFixture, description: "x".repeat(EMBED_PREVIEW_LIMITS.descriptionLength + 1) },
    ];

    for (const preview of malformed) {
      expect(() => mountTestPlayground({ preview: preview as PlaygroundPreview })).toThrow(TypeError);
    }

    const longest = {
      title: "x".repeat(EMBED_PREVIEW_LIMITS.titleLength),
      description: "x".repeat(EMBED_PREVIEW_LIMITS.descriptionLength),
      runtime: [
        { drizzleOrm: "x".repeat(EMBED_PREVIEW_LIMITS.runtimeTextLength), database: "SQLite" },
        { drizzleOrm: "1.0.0-rc.5", database: "x".repeat(EMBED_PREVIEW_LIMITS.runtimeTextLength) },
      ],
      author: "x".repeat(39),
    } satisfies PlaygroundPreview;
    expect(() => mountTestPlayground({ preview: longest })).not.toThrow();
    expect(() => mountTestPlayground({ preview: { title: "Users" } })).not.toThrow();
  });

  it("should refuse a height that is not a positive whole number of pixels", () => {
    for (const height of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "600"]) {
      expect(() => mountTestPlayground({ height: height as number })).toThrow(TypeError);
    }
  });

  it("should add no style to the host document", () => {
    const { document, host } = mountTestPlayground();

    clickLoaderButton(host);

    expect(document.head.childNodes).toHaveLength(0);
    expect(document.adoptedStyleSheets).toHaveLength(0);
  });

  it("should style the shadow root with a constructable sheet, which a strict host CSP allows", () => {
    const { host } = mountTestPlayground();

    clickLoaderButton(host);

    expect(getLoaderRoot(host).adoptedStyleSheets).toHaveLength(1);
    expect(getLoaderRoot(host).adoptedStyleSheets[0]?.text).toContain(".panel{");
    expect(getLoaderRoot(host).querySelectorAll("style")).toHaveLength(0);
  });

  it("should fall back to a style element where constructable sheets are missing", () => {
    const document = new FakeDocument();
    document.view.CSSStyleSheet = undefined;
    const { host } = mountTestPlayground({ document });

    clickLoaderButton(host);

    expect(getLoaderRoot(host).querySelectorAll("style")).toHaveLength(1);
    expect(getLoaderRoot(host).querySelector("iframe")).not.toBeNull();
  });

  it("should keep the frame's box inline, so it never depends on the sheet", () => {
    const { host } = mountTestPlayground();

    clickLoaderButton(host);
    const frame = getFrame(host);

    expect({ display: frame.style.display, width: frame.style.width, border: frame.style.border }).toEqual({
      display: "block",
      width: "100%",
      border: "0",
    });
  });

  it("should open the frame at the default height, with a container height winning", () => {
    const { host } = mountTestPlayground();

    clickLoaderButton(host);
    const frame = getFrame(host);

    expect(EMBED_DEFAULT_HEIGHT).toBe(585);
    expect({
      height: frame.style.height,
      minHeight: frame.style.minHeight,
      maxHeight: frame.style.maxHeight,
    }).toEqual({ height: `${EMBED_DEFAULT_HEIGHT}px`, minHeight: "100%", maxHeight: "100%" });
  });

  it("should give the cover the frame's height, so the page does not shift on the click", () => {
    const { host } = mountTestPlayground({ height: 600 });
    const sheet = getLoaderRoot(host).adoptedStyleSheets[0]?.text ?? "";

    expect(sheet).toMatch(/\.cover,\.panel\{[^}]*height:600px;min-height:100%;max-height:100%/);
    expect(sheet).not.toMatch(/aspect-ratio/);

    clickLoaderButton(host);

    expect(getFrame(host).style.height).toBe("600px");
  });

  it("should keep the cover dark, let the other states follow the host, and leave the frame URL alone without a theme", () => {
    const { host } = mountTestPlayground();
    const sheet = getLoaderRoot(host).adoptedStyleSheets[0]?.text ?? "";

    expect(sheet).toMatch(/:host\{[^}]*color-scheme:inherit/);
    expect(sheet).toContain(`.cover{--bg:${palette.dark.bg};`);
    expect(sheet).toContain("light-dark(");

    clickLoaderButton(host);

    expect(new URL(getFrame(host).getAttribute("src") ?? "").searchParams.has("theme")).toBe(false);
  });

  it.each(["light", "dark"] as const)("should paint every state %s and open the frame in it", (theme) => {
    const { host } = mountTestPlayground({ theme });
    const sheet = getLoaderRoot(host).adoptedStyleSheets[0]?.text ?? "";

    expect(sheet).toMatch(new RegExp(`:host\\{[^}]*color-scheme:${theme}`));
    expect(sheet).toContain(`.cover{--bg:${palette[theme].bg};`);
    expect(sheet).toContain(`.panel{--bg:${palette[theme].bg};`);
    expect(sheet).not.toContain("light-dark(");

    clickLoaderButton(host);
    const frameUrl = new URL(getFrame(host).getAttribute("src") ?? "");

    expect(frameUrl.searchParams.get("theme")).toBe(theme);
    expect(frameUrl.hash).toMatch(/^#nonce=/);
  });

  it("should reject a theme other than light or dark before replacing the host content", () => {
    const document = new FakeDocument();
    const host = new FakeElement("div", document);
    const original = new FakeElement("p", document);
    host.append(original);
    const options = {
      snapshotId: "snapshot_123",
      baseUrl: APP_ORIGIN,
      preview: previewFixture,
    } satisfies MountPlaygroundOptions;
    Reflect.set(options, "theme", "sepia");

    expect(() => mountPlayground(asHTMLElement(host), options)).toThrow(
      new TypeError('Expected theme to be "light" or "dark", but got sepia.'),
    );
    expect(host.firstChild).toBe(original);
  });

  it("should give the panels after the click the chosen height, let a container height win, and never set one on the host", () => {
    const { host } = mountTestPlayground({ height: 480 });
    const sheet = getLoaderRoot(host).adoptedStyleSheets[0]?.text ?? "";

    expect(sheet).toMatch(/:host\{[^}]*height:100%/);
    expect(sheet).not.toMatch(/:host\{[^}]*min-height/);
    expect(sheet).toMatch(/\.panel\{[^}]*height:480px;min-height:100%;max-height:100%/);
  });

  it("should cap only panel text, so cover text keeps its own width in a wide embed", () => {
    const { host } = mountTestPlayground();
    const sheet = getLoaderRoot(host).adoptedStyleSheets[0]?.text ?? "";

    expect(sheet).toMatch(/\.panel p\{[^}]*max-width:460px/);
    expect(sheet).not.toMatch(/(^|\n)p\{[^}]*max-width/);
  });

  it("should restore the original content and leave no shadow content on dispose", () => {
    const { host, original, mountHandle } = mountTestPlayground();
    const root = host.firstChild;
    clickLoaderButton(host);
    expect(getLoaderRoot(host).querySelector("iframe")).not.toBeNull();

    mountHandle.dispose();

    expect(host.childNodes).toEqual([original]);
    expect(root?.shadowRoot?.childNodes).toHaveLength(0);
  });

  it("should set the app URL before insertion and wait for the frame handshake", () => {
    const document = new FakeDocument();
    document.onIframeInsert = (frame) => {
      const insertedUrl = new URL(frame.getAttribute("src") ?? "");
      expect(insertedUrl.pathname).toBe("/embed/snapshot_123");
      expect(new URLSearchParams(insertedUrl.hash.slice(1)).get("nonce")).toMatch(/^[a-f0-9]{32}$/);
      frame.dispatch("load");
    };
    const { host, mountHandle } = mountTestPlayground({ document });

    clickLoaderButton(host);

    const frame = getFrame(host);
    const frameWindow = getFrameWindow(frame);
    expect(frameWindow.messages).toHaveLength(0);

    const frameUrl = new URL(frame.getAttribute("src") ?? "");
    const nonce = new URLSearchParams(frameUrl.hash.slice(1)).get("nonce");
    sendFrameMessage({
      view: document.view,
      source: frameWindow,
      origin: APP_ORIGIN,
      data: {
        protocol: EMBED_PROTOCOL,
        version: EMBED_PROTOCOL_VERSION,
        kind: "hello",
        nonce: "f".repeat(32),
      },
    });
    sendFrameMessage({
      view: document.view,
      source: frameWindow,
      origin: "https://run.example.com.attacker.test",
      data: {
        protocol: EMBED_PROTOCOL,
        version: EMBED_PROTOCOL_VERSION,
        kind: "hello",
        nonce,
      },
    });
    expect(frameWindow.messages).toHaveLength(0);

    sendFrameHandshake(document.view, frame);
    expect(frameWindow.messages).toHaveLength(1);
    expect(frameWindow.messages[0]?.targetOrigin).toBe("https://run.example.com");
    mountHandle.dispose();
  });

  it("should keep the iframe absent until activation, authenticate the handshake, and clamp requested height", () => {
    const { document, host, mountHandle } = mountTestPlayground();
    let frameInsertions = 0;
    document.onIframeInsert = () => {
      frameInsertions += 1;
    };

    expect(getLoaderRoot(host).querySelector("iframe")).toBeNull();
    expect(getLoaderRoot(host).querySelector("button")?.textContent).toBe("Load playground");

    clickLoaderButton(host);
    const frame = getFrame(host);
    const frameWindow = getFrameWindow(frame);
    const frameUrl = new URL(frame.getAttribute("src") ?? "");
    expect(frameUrl.origin).toBe("https://run.example.com");
    expect(frameUrl.pathname).toBe("/embed/snapshot_123");
    expect(new URLSearchParams(frameUrl.hash.slice(1)).get("nonce")).toMatch(/^[a-f0-9]{32}$/);
    expect(isFrameRevealed(frame)).toBe(false);

    frame.dispatch("load");
    expect(frameWindow.messages).toHaveLength(0);
    sendFrameHandshake(document.view, frame);
    const connect = getConnectMessage(frame);
    expect(connect).toMatchObject({
      protocol: EMBED_PROTOCOL,
      version: EMBED_PROTOCOL_VERSION,
      kind: "connect",
      snapshotId: "snapshot_123",
    });
    expect(frameWindow.messages[0]?.targetOrigin).toBe("https://run.example.com");

    sendFrameMessage({
      view: document.view,
      source: new FakeFrameWindow(),
      origin: APP_ORIGIN,
      data: {
        protocol: EMBED_PROTOCOL,
        version: EMBED_PROTOCOL_VERSION,
        kind: "ready",
        nonce: connect.nonce,
      },
    });
    sendFrameMessage({
      view: document.view,
      source: frameWindow,
      origin: "https://attacker.example",
      data: {
        protocol: EMBED_PROTOCOL,
        version: EMBED_PROTOCOL_VERSION,
        kind: "ready",
        nonce: connect.nonce,
      },
    });
    expect(isFrameRevealed(frame)).toBe(false);

    sendFrameMessage({
      view: document.view,
      source: frameWindow,
      origin: APP_ORIGIN,
      data: {
        protocol: EMBED_PROTOCOL,
        version: EMBED_PROTOCOL_VERSION,
        kind: "ready",
        nonce: connect.nonce,
      },
    });
    expect(isFrameRevealed(frame)).toBe(true);
    expect(frameInsertions).toBe(1);
    expect(frame.parent).not.toBeNull();

    sendFrameHandshake(document.view, frame);
    expect(frameWindow.messages).toHaveLength(2);
    expect(frameWindow.messages[1]?.message).toMatchObject({
      protocol: EMBED_PROTOCOL,
      version: EMBED_PROTOCOL_VERSION,
      kind: "connect",
      nonce: connect.nonce,
      snapshotId: "snapshot_123",
    });

    sendFrameMessage({
      view: document.view,
      source: frameWindow,
      origin: APP_ORIGIN,
      data: {
        protocol: EMBED_PROTOCOL,
        version: EMBED_PROTOCOL_VERSION,
        kind: "height",
        nonce: connect.nonce,
        height: 99_999,
      },
    });
    expect(frame.style.height).toBe(`${EMBED_DEFAULT_HEIGHT}px`);
    mountHandle.dispose();
  });

  it("should offer a new tab only when the embedding context lacks support", () => {
    const { document, host, mountHandle } = mountTestPlayground({ snapshotId: "snapshot-456" });
    clickLoaderButton(host);
    const frame = getFrame(host);
    sendFrameHandshake(document.view, frame);
    const connect = getConnectMessage(frame);

    sendFrameMessage({
      view: document.view,
      source: getFrameWindow(frame),
      origin: APP_ORIGIN,
      data: {
        protocol: EMBED_PROTOCOL,
        version: EMBED_PROTOCOL_VERSION,
        kind: "capability",
        nonce: connect.nonce,
        status: "embedding_context_unsupported",
      },
    });

    const link = getLoaderRoot(host).querySelector("a");
    expect(link?.href).toBe("https://run.example.com/s/snapshot-456");
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toBe("noopener noreferrer");
    expect(link?.textContent).toBe("Open in a new tab ↗");
    expect(getLoaderRoot(host).querySelector("h2")?.textContent).toBe("Open this playground in a new tab");
    mountHandle.dispose();
  });

  it("should open an official example's guide step and link to that step for a new tab", () => {
    const { document, host, mountHandle } = mountTestPlayground({
      example: { example: "transactions", step: "02-savepoint" },
    });
    clickLoaderButton(host);
    const frame = getFrame(host);
    expect(new URL(frame.getAttribute("src") ?? "").pathname).toBe("/embed/examples/transactions/02-savepoint");

    sendFrameHandshake(document.view, frame);
    const connect = getConnectMessage(frame);
    expect(connect).toEqual({
      protocol: EMBED_PROTOCOL,
      version: EMBED_PROTOCOL_VERSION,
      kind: "connect",
      nonce: connect.nonce,
      example: "transactions",
      step: "02-savepoint",
    });

    sendFrameMessage({
      view: document.view,
      source: getFrameWindow(frame),
      origin: APP_ORIGIN,
      data: {
        protocol: EMBED_PROTOCOL,
        version: EMBED_PROTOCOL_VERSION,
        kind: "capability",
        nonce: connect.nonce,
        status: "embedding_context_unsupported",
      },
    });

    const link = getLoaderRoot(host).querySelector("a");
    expect(link?.href).toBe("https://run.example.com/examples/transactions?step=02-savepoint");
    mountHandle.dispose();
  });

  it("should refuse a malformed example or step", () => {
    expect(() => mountTestPlayground({ example: { example: "../private" } })).toThrow(TypeError);
    expect(() => mountTestPlayground({ example: { example: "transactions", step: "Step 2" } })).toThrow(TypeError);
    expect(() => mountTestPlayground({ example: { example: "" } })).toThrow(TypeError);
  });

  it("should keep and show the frame when it reports a recorded run instead of offering a new tab", () => {
    const { document, host, mountHandle } = mountTestPlayground({ snapshotId: "snapshot-456" });
    clickLoaderButton(host);
    const frame = getFrame(host);
    sendFrameHandshake(document.view, frame);
    const connect = getConnectMessage(frame);

    sendFrameMessage({
      view: document.view,
      source: getFrameWindow(frame),
      origin: APP_ORIGIN,
      data: {
        protocol: EMBED_PROTOCOL,
        version: EMBED_PROTOCOL_VERSION,
        kind: "capability",
        nonce: connect.nonce,
        status: "recorded",
      },
    });

    expect(getFrame(host)).toBe(frame);
    expect(isFrameRevealed(frame)).toBe(true);
    expect(getLoaderRoot(host).querySelector("[role=alert]")).toBeNull();
    mountHandle.dispose();
  });

  it("should explain genuine browser incompatibility without a misleading new-tab link", () => {
    const { document, host, mountHandle } = mountTestPlayground();
    clickLoaderButton(host);
    const frame = getFrame(host);
    sendFrameHandshake(document.view, frame);
    const connect = getConnectMessage(frame);

    sendFrameMessage({
      view: document.view,
      source: getFrameWindow(frame),
      origin: APP_ORIGIN,
      data: {
        protocol: EMBED_PROTOCOL,
        version: EMBED_PROTOCOL_VERSION,
        kind: "capability",
        nonce: connect.nonce,
        status: "browser_unsupported",
      },
    });

    expect(getLoaderRoot(host).querySelector("a")).toBeNull();
    expect(getLoaderRoot(host).querySelector("h2")?.textContent).toBe("This browser can't run the playground");
    mountHandle.dispose();
  });

  it("should retry a failed load with a fresh nonce and cancel the active frame on dispose", () => {
    const { document, host, original, mountHandle } = mountTestPlayground();
    clickLoaderButton(host);
    const firstFrame = getFrame(host);
    sendFrameHandshake(document.view, firstFrame);
    const firstNonce = getConnectMessage(firstFrame).nonce;
    firstFrame.dispatch("error");
    expect(getLoaderRoot(host).querySelector("button")?.textContent).toBe("Retry loading");
    expect(getLoaderRoot(host).querySelector("a")?.href).toMatch(/\/s\/snapshot_123$/);

    clickLoaderButton(host);
    const nextFrame = getFrame(host);
    sendFrameHandshake(document.view, nextFrame);
    const nextConnect = getConnectMessage(nextFrame);
    expect(nextConnect.nonce).not.toBe(firstNonce);

    mountHandle.dispose();

    expect(host.querySelector("iframe")).toBeNull();
    expect(firstFrame.getAttribute("src")).toBeNull();
    expect(nextFrame.getAttribute("src")).toBeNull();
    expect(document.view.listenerCount("message")).toBe(0);
    expect(host.firstChild).toBe(original);
  });

  it("should keep separate iframe handshakes independent", () => {
    const first = mountTestPlayground({ snapshotId: "first" });
    const second = mountTestPlayground({ document: first.document, snapshotId: "second" });
    clickLoaderButton(first.host);
    clickLoaderButton(second.host);
    const firstFrame = getFrame(first.host);
    const secondFrame = getFrame(second.host);
    sendFrameHandshake(first.document.view, firstFrame);
    sendFrameHandshake(first.document.view, secondFrame);
    const firstNonce = getConnectMessage(firstFrame).nonce;
    const secondNonce = getConnectMessage(secondFrame).nonce;

    sendFrameMessage({
      view: first.document.view,
      source: getFrameWindow(firstFrame),
      origin: APP_ORIGIN,
      data: {
        protocol: EMBED_PROTOCOL,
        version: EMBED_PROTOCOL_VERSION,
        kind: "ready",
        nonce: secondNonce,
      },
    });
    expect(isFrameRevealed(firstFrame)).toBe(false);

    sendFrameMessage({
      view: first.document.view,
      source: getFrameWindow(firstFrame),
      origin: APP_ORIGIN,
      data: {
        protocol: EMBED_PROTOCOL,
        version: EMBED_PROTOCOL_VERSION,
        kind: "ready",
        nonce: firstNonce,
      },
    });
    expect(isFrameRevealed(firstFrame)).toBe(true);
    expect(isFrameRevealed(secondFrame)).toBe(false);
    first.mountHandle.dispose();
    second.mountHandle.dispose();
  });

  it("should ignore a ready message from an untrusted origin", () => {
    const { document, host, mountHandle } = mountTestPlayground();
    clickLoaderButton(host);
    const frame = getFrame(host);
    sendFrameHandshake(document.view, frame);
    const connect = getConnectMessage(frame);

    sendFrameMessage({
      view: document.view,
      source: getFrameWindow(frame),
      origin: "https://run.example.com.attacker.test",
      data: {
        protocol: EMBED_PROTOCOL,
        version: EMBED_PROTOCOL_VERSION,
        kind: "ready",
        nonce: connect.nonce,
      },
    });

    expect(isFrameRevealed(frame)).toBe(false);
    mountHandle.dispose();
  });

  it("should restore host content on disposal before activation", () => {
    const { document, host, original, mountHandle } = mountTestPlayground();
    expect(document.view.listenerCount("message")).toBe(1);

    mountHandle.dispose();

    expect(host.firstChild).toBe(original);
    expect(host.querySelector("iframe")).toBeNull();
    expect(document.view.listenerCount("message")).toBe(0);
  });
});

/** Activates the loader, completes the handshake, and returns a sender for the frame's lifecycle messages. */
function connectTestFrame(document: FakeDocument, host: FakeElement) {
  clickLoaderButton(host);
  const frame = getFrame(host);
  sendFrameHandshake(document.view, frame);
  const { nonce } = getConnectMessage(frame);

  const sendLifecycle = (message: Record<string, unknown>) =>
    sendFrameMessage({
      view: document.view,
      source: getFrameWindow(frame),
      origin: APP_ORIGIN,
      data: { protocol: EMBED_PROTOCOL, version: EMBED_PROTOCOL_VERSION, nonce, ...message },
    });

  return { frame, sendLifecycle };
}

describe("mountPlayground host events", () => {
  it.each(["capability", "error"] as const)(
    "should synchronously restore the host and suppress later notifications when disposed from %s",
    (kind) => {
      const onReady = vi.fn();
      let restoredBeforeReturn = false;
      const callback = () => {
        mountHandle.dispose();
        restoredBeforeReturn = host.firstChild === original;
        host.replaceChildren(replacement);
      };
      const { document, host, original, mountHandle } = mountTestPlayground({
        callbacks: { onReady, onCapability: kind === "capability" ? callback : undefined, onError: callback },
      });
      const replacement = new FakeElement("p", document);
      const loaderRoot = getLoaderRoot(host);
      const { sendLifecycle } = connectTestFrame(document, host);

      sendLifecycle(kind === "capability" ? { kind, status: "recorded" } : { kind, code: "application_load" });

      expect(onReady).not.toHaveBeenCalled();
      expect(restoredBeforeReturn).toBe(true);
      expect(host.firstChild).toBe(replacement);
      expect(loaderRoot.childNodes).toEqual([]);
      expect(document.view.listenerCount("message")).toBe(0);
      mountHandle.dispose();
      expect(host.firstChild).toBe(replacement);
    },
  );

  it("should report the capability, then ready, to the callback and to event listeners", () => {
    const onReady = vi.fn();
    const onCapability = vi.fn();
    const { document, host, mountHandle } = mountTestPlayground({ callbacks: { onReady, onCapability } });
    const dispatched: string[] = [];
    mountHandle.addEventListener("capability", (event) => dispatched.push(`capability:${event.detail.status}`));
    mountHandle.addEventListener("ready", (event) => dispatched.push(`ready:${event.detail.mode}`));
    const { sendLifecycle } = connectTestFrame(document, host);

    sendLifecycle({ kind: "capability", status: "available" });
    sendLifecycle({ kind: "ready" });

    expect(onCapability).toHaveBeenCalledExactlyOnceWith({ status: "available" });
    expect(onReady).toHaveBeenCalledExactlyOnceWith({ mode: "live" });
    expect(dispatched).toEqual(["capability:available", "ready:live"]);
    mountHandle.dispose();
  });

  it("should report a recorded run as its capability and as a recorded ready", () => {
    const onReady = vi.fn();
    const onCapability = vi.fn();
    const { document, host, mountHandle } = mountTestPlayground({ callbacks: { onReady, onCapability } });
    const { sendLifecycle } = connectTestFrame(document, host);

    sendLifecycle({ kind: "capability", status: "recorded" });

    expect(onCapability).toHaveBeenCalledExactlyOnceWith({ status: "recorded" });
    expect(onReady).toHaveBeenCalledExactlyOnceWith({ mode: "recorded" });
    mountHandle.dispose();
  });

  it("should report a recorded ready for the frame's order: a recorded capability, then ready", () => {
    const onReady = vi.fn();
    const onCapability = vi.fn();
    const { document, host, mountHandle } = mountTestPlayground({ callbacks: { onReady, onCapability } });
    const { sendLifecycle } = connectTestFrame(document, host);

    sendLifecycle({ kind: "capability", status: "recorded" });
    sendLifecycle({ kind: "ready" });

    expect(onCapability).toHaveBeenCalledExactlyOnceWith({ status: "recorded" });
    expect(onReady).toHaveBeenCalledExactlyOnceWith({ mode: "recorded" });
    mountHandle.dispose();
  });

  it("should report an unsupported page as its capability and never as ready", () => {
    const onReady = vi.fn();
    const onCapability = vi.fn();
    const { document, host, mountHandle } = mountTestPlayground({ callbacks: { onReady, onCapability } });
    const { sendLifecycle } = connectTestFrame(document, host);

    sendLifecycle({ kind: "capability", status: "embedding_context_unsupported" });
    sendLifecycle({ kind: "ready" });

    expect(onCapability).toHaveBeenCalledExactlyOnceWith({ status: "embedding_context_unsupported" });
    expect(onReady).not.toHaveBeenCalled();
    mountHandle.dispose();
  });

  it("should report the frame's error code, and frame_load when the frame itself fails", () => {
    const onError = vi.fn();
    const { document, host, mountHandle } = mountTestPlayground({ callbacks: { onError } });
    const { sendLifecycle } = connectTestFrame(document, host);

    sendLifecycle({ kind: "error", code: "initialization" });
    const { frame: retriedFrame } = connectTestFrame(document, host);
    retriedFrame.dispatch("error");

    expect(onError.mock.calls).toEqual([[{ code: "initialization" }], [{ code: "frame_load" }]]);
    mountHandle.dispose();
  });

  it("should report a timeout when the frame never gets ready", () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const { document, host, mountHandle } = mountTestPlayground({ callbacks: { onError } });
    connectTestFrame(document, host);

    vi.advanceTimersByTime(30_000);

    expect(onError).toHaveBeenCalledExactlyOnceWith({ code: "timeout" });
    expect(getLoaderRoot(host).querySelector("button")?.textContent).toBe("Retry loading");
    mountHandle.dispose();
  });

  it("should stop calling a removed listener and dispatch nothing after dispose", () => {
    const onReady = vi.fn();
    const listener = vi.fn();
    const { document, host, mountHandle } = mountTestPlayground({ callbacks: { onReady } });
    mountHandle.addEventListener("ready", listener);
    mountHandle.removeEventListener("ready", listener);
    const { sendLifecycle } = connectTestFrame(document, host);

    mountHandle.dispose();
    sendLifecycle({ kind: "ready" });

    expect(listener).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
  });
});

describe("mountPlayground unavailable playgrounds", () => {
  it("should say a removed playground no longer exists, link to the examples, and offer no retry", () => {
    const onError = vi.fn();
    const { document, host, mountHandle } = mountTestPlayground({ callbacks: { onError } });
    const { sendLifecycle } = connectTestFrame(document, host);

    sendLifecycle({ kind: "error", code: "not_found" });

    const root = getLoaderRoot(host);
    expect(onError).toHaveBeenCalledExactlyOnceWith({ code: "not_found" });
    expect(root.querySelector("h2")?.textContent).toBe("This playground no longer exists");
    expect(root.querySelector("button")).toBeNull();
    expect(root.querySelector("iframe")).toBeNull();
    expect(root.querySelector("a")?.href).toBe(`${APP_ORIGIN}/examples`);
    expect(root.querySelector("a")?.textContent).toBe("Browse examples ↗");
    mountHandle.dispose();
  });

  it("should say a playground cannot open here, link to the full playground, and offer no retry", () => {
    const onError = vi.fn();
    const { document, host, mountHandle } = mountTestPlayground({ callbacks: { onError } });
    const { sendLifecycle } = connectTestFrame(document, host);

    sendLifecycle({ kind: "error", code: "unopenable" });

    const root = getLoaderRoot(host);
    expect(onError).toHaveBeenCalledExactlyOnceWith({ code: "unopenable" });
    expect(root.querySelector("h2")?.textContent).toBe("This playground can't open here");
    expect(root.querySelector("button")).toBeNull();
    expect(root.querySelector("iframe")).toBeNull();
    expect(root.querySelector("a")?.textContent).toBe("Open in Drizzle Run ↗");
    expect(root.querySelector("a")?.href).not.toBe(`${APP_ORIGIN}/examples`);
    mountHandle.dispose();
  });

  it("should ask for a page served over HTTP(S) when the frame cannot answer an opaque host", () => {
    const onError = vi.fn();
    const { document, host, mountHandle } = mountTestPlayground({ callbacks: { onError } });
    const { sendLifecycle } = connectTestFrame(document, host);

    sendLifecycle({ kind: "error", code: "unsupported_host" });
    sendLifecycle({ kind: "error", code: "application_load" });

    const root = getLoaderRoot(host);
    expect(onError).toHaveBeenCalledExactlyOnceWith({ code: "unsupported_host" });
    expect(root.querySelector("h2")?.textContent).toBe("This page can't load playgrounds");
    expect(root.querySelector("p")?.textContent).toContain("served over HTTP(S)");
    expect(root.querySelector("button")).toBeNull();
    mountHandle.dispose();
  });
});

describe("mountPlayground on an opaque host page", () => {
  it("should ask for a page served over HTTP(S) without loading the frame", () => {
    const onError = vi.fn();
    const document = new FakeDocument();
    document.view.origin = "null";
    const { host, mountHandle } = mountTestPlayground({ document, callbacks: { onError } });

    clickLoaderButton(host);

    const root = getLoaderRoot(host);
    expect(onError).toHaveBeenCalledExactlyOnceWith({ code: "unsupported_host" });
    expect(root.querySelector("iframe")).toBeNull();
    expect(root.querySelector("h2")?.textContent).toBe("This page can't load playgrounds");
    expect(root.querySelector("button")).toBeNull();
    mountHandle.dispose();
  });
});

describe("mountPlayground settled runs", () => {
  const settledRun = {
    outcome: "succeeded",
    displays: [{ label: "Users", values: [{ type: "primitive", value: "Ada" }] }],
    truncated: false,
  };

  it("should report a settled run to the callback and to event listeners once the frame is ready", () => {
    const onRunSettled = vi.fn();
    const { document, host, mountHandle } = mountTestPlayground({ callbacks: { onRunSettled } });
    const listener = vi.fn();
    mountHandle.addEventListener("run-settled", (event) => listener(event.detail));
    const { sendLifecycle } = connectTestFrame(document, host);

    sendLifecycle({ kind: "run-settled", run: settledRun });
    sendLifecycle({ kind: "ready" });
    sendLifecycle({ kind: "run-settled", run: settledRun });
    sendLifecycle({
      kind: "run-settled",
      run: { outcome: "failed", side: 1, error: "boom", displays: [], truncated: true },
    });

    expect(onRunSettled.mock.calls).toEqual([
      [settledRun],
      [{ outcome: "failed", side: 1, error: "boom", displays: [], truncated: true }],
    ]);
    expect(listener.mock.calls).toEqual(onRunSettled.mock.calls);
    mountHandle.dispose();
  });

  it("should ignore a settled run from another origin, another window, or another nonce", () => {
    const onRunSettled = vi.fn();
    const { document, host, mountHandle } = mountTestPlayground({ callbacks: { onRunSettled } });
    const { frame, sendLifecycle } = connectTestFrame(document, host);
    sendLifecycle({ kind: "ready" });
    const { nonce } = getConnectMessage(frame);
    const data = {
      protocol: EMBED_PROTOCOL,
      version: EMBED_PROTOCOL_VERSION,
      kind: "run-settled",
      nonce,
      run: settledRun,
    };

    sendFrameMessage({ view: document.view, source: getFrameWindow(frame), origin: "https://attacker.test", data });
    sendFrameMessage({ view: document.view, source: new FakeFrameWindow(), origin: APP_ORIGIN, data });
    sendFrameMessage({
      view: document.view,
      source: getFrameWindow(frame),
      origin: APP_ORIGIN,
      data: { ...data, nonce: "b".repeat(32) },
    });

    expect(onRunSettled).not.toHaveBeenCalled();
    mountHandle.dispose();
  });
});

describe("embed protocol parsers", () => {
  it("should reject malformed protocol messages", () => {
    const nonce = "a".repeat(32);

    expect(
      parseEmbedHelloMessage({
        protocol: EMBED_PROTOCOL,
        version: EMBED_PROTOCOL_VERSION,
        kind: "hello",
        nonce,
      }),
    ).toEqual({
      protocol: EMBED_PROTOCOL,
      version: EMBED_PROTOCOL_VERSION,
      kind: "hello",
      nonce,
    });
    expect(
      parseEmbedHelloMessage({
        protocol: EMBED_PROTOCOL,
        version: EMBED_PROTOCOL_VERSION,
        kind: "hello",
        nonce,
        html: "<script>run()</script>",
      }),
    ).toBeNull();
    expect(
      parseEmbedConnectMessage({
        protocol: EMBED_PROTOCOL,
        version: EMBED_PROTOCOL_VERSION,
        kind: "connect",
        nonce,
        snapshotId: "snapshot_123",
      }),
    ).toEqual({
      protocol: EMBED_PROTOCOL,
      version: EMBED_PROTOCOL_VERSION,
      kind: "connect",
      nonce,
      snapshotId: "snapshot_123",
    });
    expect(
      parseEmbedConnectMessage({
        protocol: EMBED_PROTOCOL,
        version: EMBED_PROTOCOL_VERSION,
        kind: "connect",
        nonce,
        snapshotId: "../private",
      }),
    ).toBeNull();
    expect(
      parseEmbedConnectMessage({
        protocol: EMBED_PROTOCOL,
        version: EMBED_PROTOCOL_VERSION,
        kind: "connect",
        nonce,
        example: "quick-start-sqlite",
      }),
    ).toEqual({
      protocol: EMBED_PROTOCOL,
      version: EMBED_PROTOCOL_VERSION,
      kind: "connect",
      nonce,
      example: "quick-start-sqlite",
    });
    expect(
      parseEmbedConnectMessage({
        protocol: EMBED_PROTOCOL,
        version: EMBED_PROTOCOL_VERSION,
        kind: "connect",
        nonce,
        snapshotId: "snapshot_123",
        example: "quick-start-sqlite",
      }),
    ).toBeNull();
    expect(
      parseEmbedConnectMessage({
        protocol: EMBED_PROTOCOL,
        version: EMBED_PROTOCOL_VERSION,
        kind: "connect",
        nonce,
        example: "transactions",
        step: "../01",
      }),
    ).toBeNull();
    expect(
      parseEmbedFrameMessage({
        protocol: EMBED_PROTOCOL,
        version: EMBED_PROTOCOL_VERSION,
        kind: "ready",
        nonce,
        html: "<script>run()</script>",
      }),
    ).toBeNull();
    expect(
      parseEmbedFrameMessage({
        protocol: EMBED_PROTOCOL,
        version: EMBED_PROTOCOL_VERSION,
        kind: "navigate",
        nonce,
        url: "https://attacker.example",
      }),
    ).toBeNull();
  });
});

describe("embed target paths", () => {
  it("should map each target to its frame and its full playground", () => {
    expect(getEmbedFramePath({ snapshotId: "abc" })).toBe("/embed/abc");
    expect(getEmbedPlaygroundPath({ snapshotId: "abc" })).toBe("/s/abc");
    expect(getEmbedFramePath({ example: "transactions" })).toBe("/embed/examples/transactions");
    expect(getEmbedPlaygroundPath({ example: "transactions" })).toBe("/examples/transactions");
    expect(getEmbedFramePath({ example: "transactions", step: "02-savepoint" })).toBe(
      "/embed/examples/transactions/02-savepoint",
    );
    expect(getEmbedPlaygroundPath({ example: "transactions", step: "02-savepoint" })).toBe(
      "/examples/transactions?step=02-savepoint",
    );
  });
});

describe("parseEmbedFrameMessage", () => {
  const nonce = "a".repeat(32);
  const envelope = { protocol: EMBED_PROTOCOL, version: EMBED_PROTOCOL_VERSION, nonce };

  function makeRunSettled(run: Record<string, unknown>) {
    return { ...envelope, kind: "run-settled", run };
  }

  it("should accept every frame error code and reject one it does not know, as older loaders do", () => {
    for (const code of EMBED_FRAME_ERROR_CODES) {
      expect(parseEmbedFrameMessage({ ...envelope, kind: "error", code })).toEqual({
        ...envelope,
        kind: "error",
        code,
      });
    }

    expect(parseEmbedFrameMessage({ ...envelope, kind: "error", code: "gone_fishing" })).toBeNull();
  });

  it("should parse a settled run with its side and error", () => {
    const run = {
      outcome: "failed",
      side: 0,
      error: "relation does not exist",
      displays: [{ label: "Rows", values: [{ type: "array", value: [{ type: "primitive", value: null }] }] }],
      truncated: false,
    };

    expect(parseEmbedFrameMessage(makeRunSettled(run))).toEqual(makeRunSettled(run));
    expect(parseEmbedFrameMessage(makeRunSettled({ outcome: "cancelled", displays: [], truncated: false }))).toEqual(
      makeRunSettled({ outcome: "cancelled", displays: [], truncated: false }),
    );
  });

  it("should reject a malformed settled run", () => {
    const valid = { outcome: "succeeded", displays: [], truncated: false };
    const malformed: Record<string, unknown>[] = [
      { ...valid, outcome: "done" },
      { ...valid, side: 2 },
      { ...valid, side: undefined },
      { ...valid, error: "only a failed run has one" },
      { ...valid, outcome: "failed", error: "e".repeat(EMBED_MAX_RUN_ERROR_LENGTH + 1) },
      { ...valid, truncated: "no" },
      { ...valid, html: "<script>run()</script>" },
      { ...valid, displays: [{ label: "Rows", values: [], source: "query.ts" }] },
      { ...valid, displays: [{ label: 1, values: [] }] },
      { ...valid, displays: [{ label: "Rows", values: [Number.NaN] }] },
      { ...valid, displays: [{ label: "Rows", values: [new Date(0)] }] },
      { ...valid, displays: [{ label: "Rows", values: [undefined] }] },
      { ...valid, displays: [{ label: "Rows", values: ["x".repeat(EMBED_MAX_RUN_DISPLAYS_BYTES)] }] },
    ];

    for (const run of malformed) {
      expect(parseEmbedFrameMessage(makeRunSettled(run))).toBeNull();
    }

    expect(parseEmbedFrameMessage({ ...makeRunSettled(valid), extra: true })).toBeNull();
  });

  it("should reject display values nested past the depth any serialized value reaches", () => {
    let deep: unknown = "leaf";

    for (let level = 0; level < 200; level += 1) {
      deep = [deep];
    }

    const run = { outcome: "succeeded", displays: [{ label: "Deep", values: [deep] }], truncated: false };

    expect(parseEmbedFrameMessage(makeRunSettled(run))).toBeNull();
  });
});

describe("getEmbedJsonByteLength", () => {
  it("should count UTF-8 bytes of the JSON text", () => {
    expect(getEmbedJsonByteLength(["é"])).toBe(6);
  });
});
