import { describe, expect, it, vi } from "vitest";
import { createActor } from "xstate";

import {
  createPostgresSessionMachine,
  getConnectionPhase,
  type PostgresSessionEvent,
} from "./postgres-session-machine.ts";

const authenticated = { type: 0x52, body: new Uint8Array(4) };

function readyForQuery(status: "I" | "T" | "E") {
  return { type: 0x5a, body: Uint8Array.of(status.charCodeAt(0)) };
}

function startSession({ waitingNoticeMs = 1_000 }: { waitingNoticeMs?: number } = {}) {
  const onWaiting = vi.fn();
  const actor = createActor(createPostgresSessionMachine({ onWaiting, waitingNoticeMs })).start();
  const send = (...events: PostgresSessionEvent[]) => {
    for (const event of events) {
      actor.send(event);
    }
  };
  const openReady = (connection: number, status: "I" | "T" | "E" = "I") =>
    send(
      { type: "connection.opened", connection },
      { type: "reply.received", connection, frames: [authenticated, readyForQuery(status)], closes: false },
    );

  return { actor, onWaiting, send, openReady };
}

describe("postgres session machine", () => {
  it("should give the session to a connection inside a transaction and take it back once it is idle", () => {
    const { actor, send, openReady } = startSession();

    openReady(1);
    send(
      { type: "frames.sent", connection: 1, frames: [{ type: 0x51 }] },
      { type: "reply.received", connection: 1, frames: [readyForQuery("T")], closes: false },
    );
    const inTransaction = actor.getSnapshot().context.owner;
    send({ type: "reply.received", connection: 1, frames: [readyForQuery("I")], closes: false });

    expect(inTransaction).toBe(1);
    expect(actor.getSnapshot().context.owner).toBeUndefined();
  });

  it("should grant each exchange with its connection's phase: startup, ready, then closed", () => {
    const { send } = startSession();
    const phases: string[] = [];
    const exchange = (connection: number) => {
      send({ type: "exchange.requested", connection, closing: false, grant: (phase) => phases.push(phase) });
      send({ type: "exchange.finished" });
    };

    send({ type: "connection.opened", connection: 1 });
    exchange(1);
    send({ type: "reply.received", connection: 1, frames: [authenticated, readyForQuery("I")], closes: false });
    exchange(1);
    send({ type: "connection.closed", connection: 1 });
    exchange(1);

    expect(phases).toEqual(["startup", "ready", "closed"]);
  });

  it("should hold the session for frames sent without their Sync", () => {
    const { actor, send, openReady } = startSession();

    openReady(1);
    send(
      { type: "frames.sent", connection: 1, frames: [{ type: 0x50 }, { type: 0x42 }, { type: 0x45 }] },
      { type: "reply.received", connection: 1, frames: [], closes: false },
    );

    expect(actor.getSnapshot().context.owner).toBe(1);
    expect(actor.getSnapshot().children["connection-1"]?.getSnapshot().context).toMatchObject({ unsynced: true });
  });

  it("should free the session when its holder closes, and ignore later events for it", () => {
    const { actor, send, openReady } = startSession();

    openReady(1, "T");
    send({ type: "connection.closed", connection: 1 });
    send({ type: "reply.received", connection: 1, frames: [readyForQuery("T")], closes: false });

    expect(actor.getSnapshot().context.owner).toBeUndefined();
    expect(getConnectionPhase(actor.getSnapshot(), 1)).toBe("closed");
    expect(actor.getSnapshot().children["connection-1"]).toBeUndefined();
  });

  it("should not hold the session for a connection still in its startup", () => {
    const { actor, send } = startSession();

    send(
      { type: "connection.opened", connection: 1 },
      { type: "frames.sent", connection: 1, frames: [{ type: undefined }] },
      { type: "reply.received", connection: 1, frames: [], closes: false },
    );

    expect(actor.getSnapshot().context.owner).toBeUndefined();
    expect(getConnectionPhase(actor.getSnapshot(), 1)).toBe("startup");
  });

  it("should run one exchange at a time, and grant a waiting connection once the holder's transaction ends", () => {
    const { actor, send, openReady } = startSession();
    const grants: string[] = [];

    openReady(1, "T");
    openReady(2);
    send({ type: "exchange.requested", connection: 2, closing: false, grant: () => grants.push("second") });
    send({ type: "exchange.requested", connection: 1, closing: false, grant: () => grants.push("holder") });

    expect(grants).toEqual(["holder"]);
    expect(actor.getSnapshot().matches("exchanging")).toBe(true);

    send(
      { type: "reply.received", connection: 1, frames: [readyForQuery("I")], closes: false },
      { type: "exchange.finished" },
    );

    expect(grants).toEqual(["holder", "second"]);
    send({ type: "exchange.finished" });
    expect(actor.getSnapshot().matches("free")).toBe(true);
  });

  it("should let a closing connection through while another holds the session", () => {
    const { send, openReady } = startSession();
    const grant = vi.fn();

    openReady(1, "T");
    openReady(2);
    send({ type: "exchange.requested", connection: 2, closing: true, grant });

    expect(grant).toHaveBeenCalledOnce();
  });

  it("should report a ready connection that waited for the holder, and not one granted in time", async () => {
    const { send, openReady, onWaiting } = startSession({ waitingNoticeMs: 10 });

    openReady(1, "T");
    openReady(2);
    openReady(3);
    send({ type: "exchange.requested", connection: 2, closing: false, grant: () => {} });
    send({ type: "exchange.requested", connection: 1, closing: false, grant: () => {} });
    send({ type: "exchange.requested", connection: 3, closing: false, grant: () => {} });
    send(
      { type: "reply.received", connection: 1, frames: [readyForQuery("I")], closes: false },
      { type: "exchange.finished" },
    );

    await vi.waitFor(() => expect(onWaiting).toHaveBeenCalledWith({ connection: 3, owner: undefined }));
    expect(onWaiting).not.toHaveBeenCalledWith(expect.objectContaining({ connection: 2 }));
  });
});
