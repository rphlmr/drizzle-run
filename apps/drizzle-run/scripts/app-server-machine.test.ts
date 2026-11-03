import { describe, expect, it, vi } from "vitest";
import { createActor } from "xstate";

import { appServerMachine } from "./app-server-machine.ts";

function startAppServer() {
  const stopServer = vi.fn();
  const actor = createActor(appServerMachine.provide({ actions: { stopServer } })).start();

  return { actor, stopServer };
}

describe("appServerMachine", () => {
  it("should exit 0 when a requested stop ends the server by signal", () => {
    const { actor, stopServer } = startAppServer();

    actor.send({ type: "stop.request" });
    actor.send({ type: "server.exited", code: null });

    expect(stopServer).toHaveBeenCalledOnce();
    expect(actor.getSnapshot().status).toBe("done");
    expect(actor.getSnapshot().context.exitCode).toBe(0);
  });

  it("should exit 0 when the server handles the requested SIGTERM itself", () => {
    const { actor } = startAppServer();

    actor.send({ type: "stop.request" });
    actor.send({ type: "server.exited", code: 143 });

    expect(actor.getSnapshot().context.exitCode).toBe(0);
  });

  it("should fail when the server dies from a signal nobody requested", () => {
    const { actor, stopServer } = startAppServer();

    actor.send({ type: "server.exited", code: null });

    expect(stopServer).toHaveBeenCalledOnce();
    expect(actor.getSnapshot().context.exitCode).toBe(1);
  });

  it("should keep the server's own exit code", () => {
    const { actor } = startAppServer();

    actor.send({ type: "server.exited", code: 3 });

    expect(actor.getSnapshot().context.exitCode).toBe(3);
  });

  it("should stop once when a second signal arrives while stopping", () => {
    const { actor, stopServer } = startAppServer();

    actor.send({ type: "stop.request" });
    actor.send({ type: "stop.request" });

    expect(stopServer).toHaveBeenCalledOnce();
    expect(actor.getSnapshot().value).toBe("stopping");
  });

  it("should fail when the server cannot start, and ignore a later exit", () => {
    const { actor, stopServer } = startAppServer();

    actor.send({ type: "server.failed" });
    actor.send({ type: "server.exited", code: 0 });

    expect(stopServer).toHaveBeenCalledOnce();
    expect(actor.getSnapshot().context.exitCode).toBe(1);
  });
});
