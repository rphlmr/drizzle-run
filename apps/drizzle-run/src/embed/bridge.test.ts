import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EMBED_PROTOCOL, EMBED_PROTOCOL_VERSION, type EmbedTarget } from "../embed-loader/protocol";

const origin = "https://blog.example.test";
const nonce = "0123456789abcdef0123456789abcdef";

function makeFakeWindow(pathname = "/embed/snap_123", hash = `#nonce=${nonce}`) {
  let onMessage: ((event: MessageEvent<unknown>) => void) | undefined;
  const parent = { postMessage: vi.fn() };
  const view = {
    parent: undefined as unknown,
    location: { pathname, hash },
    addEventListener: vi.fn((type: string, listener: EventListener | EventListenerObject) => {
      if (type === "message") {
        onMessage = listener as (event: MessageEvent<unknown>) => void;
      }
    }),
    removeEventListener: vi.fn((type: string, listener: EventListener | EventListenerObject) => {
      if (type === "message" && onMessage === listener) {
        onMessage = undefined;
      }
    }),
  };
  view.parent = parent;
  vi.stubGlobal("window", view);

  return {
    parent,
    dispatch(event: Partial<MessageEvent<unknown>>) {
      onMessage?.(event as MessageEvent<unknown>);
    },
  };
}

function connectMessage(target: string | EmbedTarget = "snap_123", messageNonce = nonce) {
  return {
    protocol: EMBED_PROTOCOL,
    version: EMBED_PROTOCOL_VERSION,
    kind: "connect",
    nonce: messageNonce,
    ...(typeof target === "string" ? { snapshotId: target } : target),
  };
}

function makeListeners() {
  return { onConnect: vi.fn(), onOpaqueConnect: vi.fn() };
}

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("createEmbedBridge", () => {
  it("should greet the parent, then hear only the parent window naming this route with the address's nonce", async () => {
    const view = makeFakeWindow();
    const { createEmbedBridge } = await import("./bridge");
    const bridge = createEmbedBridge({ snapshotId: "snap_123" });
    const listeners = makeListeners();
    const source = view.parent as unknown as MessageEventSource;

    bridge.start(listeners);
    view.dispatch({ source: {} as MessageEventSource, origin, data: connectMessage() });
    view.dispatch({ source, origin, data: connectMessage("another-snapshot") });
    view.dispatch({ source, origin, data: { ...connectMessage(), nonce: "bad" } });
    view.dispatch({ source, origin, data: connectMessage() });

    expect(view.parent.postMessage).toHaveBeenCalledExactlyOnceWith(
      { protocol: EMBED_PROTOCOL, version: EMBED_PROTOCOL_VERSION, kind: "hello", nonce },
      "*",
    );
    expect(listeners.onConnect).toHaveBeenCalledExactlyOnceWith({ nonce, origin });
    bridge.dispose();
  });

  it("should require a valid fragment nonce before announcing or accepting a parent", async () => {
    const view = makeFakeWindow("/embed/snap_123", "#nonce=invalid");
    const { createEmbedBridge } = await import("./bridge");
    const bridge = createEmbedBridge({ snapshotId: "snap_123" });
    const listeners = makeListeners();

    bridge.start(listeners);
    view.dispatch({ source: view.parent as unknown as MessageEventSource, origin, data: connectMessage() });

    expect(view.parent.postMessage).not.toHaveBeenCalled();
    expect(listeners.onConnect).not.toHaveBeenCalled();
    bridge.dispose();
  });

  it("should connect an official example's guide step only to a parent naming that step", async () => {
    const view = makeFakeWindow("/embed/examples/transactions/02-savepoint");
    const { createEmbedBridge } = await import("./bridge");
    const bridge = createEmbedBridge({ example: "transactions", step: "02-savepoint" });
    const listeners = makeListeners();
    const source = view.parent as unknown as MessageEventSource;

    bridge.start(listeners);
    view.dispatch({ source, origin, data: connectMessage({ example: "transactions", step: "01-as-written" }) });
    view.dispatch({ source, origin, data: connectMessage({ example: "transactions" }) });
    view.dispatch({ source, origin, data: connectMessage("transactions") });
    expect(listeners.onConnect).not.toHaveBeenCalled();

    view.dispatch({ source, origin, data: connectMessage({ example: "transactions", step: "02-savepoint" }) });

    expect(listeners.onConnect).toHaveBeenCalledOnce();
    bridge.dispose();
  });

  it("should report an opaque parent apart, and tell it it cannot connect with the nonce it sent", async () => {
    const view = makeFakeWindow();
    const { createEmbedBridge } = await import("./bridge");
    const bridge = createEmbedBridge({ snapshotId: "snap_123" });
    const listeners = makeListeners();
    const source = view.parent as unknown as MessageEventSource;

    bridge.start(listeners);
    view.dispatch({ source, origin: "null", data: connectMessage("another-snapshot") });
    view.dispatch({ source, origin: "null", data: connectMessage() });
    bridge.postUnsupportedHost(nonce);

    expect(listeners.onOpaqueConnect).toHaveBeenCalledExactlyOnceWith(nonce);
    expect(listeners.onConnect).not.toHaveBeenCalled();
    expect(view.parent.postMessage).toHaveBeenLastCalledWith(
      { protocol: EMBED_PROTOCOL, version: EMBED_PROTOCOL_VERSION, kind: "error", nonce, code: "unsupported_host" },
      "*",
    );
    bridge.dispose();
  });

  it("should post in the protocol's envelope to the connected origin, and stop hearing parents once disposed", async () => {
    const view = makeFakeWindow();
    const { createEmbedBridge } = await import("./bridge");
    const bridge = createEmbedBridge({ snapshotId: "snap_123" });
    const listeners = makeListeners();

    bridge.start(listeners);
    bridge.post({ nonce, origin }, { kind: "capability", status: "available" });
    bridge.dispose();
    view.dispatch({ source: view.parent as unknown as MessageEventSource, origin, data: connectMessage() });

    expect(view.parent.postMessage).toHaveBeenLastCalledWith(
      { protocol: EMBED_PROTOCOL, version: EMBED_PROTOCOL_VERSION, kind: "capability", nonce, status: "available" },
      origin,
    );
    expect(listeners.onConnect).not.toHaveBeenCalled();
  });
});
