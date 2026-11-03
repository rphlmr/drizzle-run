import {
  CONNECT_PROTOCOL,
  deriveConnectKeys,
  roomProtocols,
  parseRelayServerFrame,
  SecureChannel,
  sharedProtocolVersion,
  type CompanionInfo,
  type ConnectRole,
  type RelayBusyFrame,
  type RelayQuotaFrame,
} from "@drizzle-run/core/connect";
import { and, assign, enqueueActions, fromCallback, fromPromise, sendParent, sendTo, setup } from "xstate";

import type {
  CompanionMessage,
  ConnectServices,
  ConnectToolOutcome,
  ConnectToolRequest,
  EditStoreCommand,
  InternalEvent,
  Job,
  LinkCommand,
  LinkEvent,
  PendingEdit,
  QueuedJob,
} from "./connect-contract.ts";
import { declareType } from "./declare-type.ts";
import { getErrorText } from "./error-text.ts";

/** The AI chat link's actors: the sealed relay link, the tool and undo queue, and the pending edit store. */

/** Keeps pending edits through the host, one save at a time, in order. */
export function createEditStoreLogic(services: ConnectServices) {
  return fromCallback<EditStoreCommand>(({ receive }) => {
    let saveQueue: Promise<void> = Promise.resolve();

    receive((command) => {
      saveQueue = saveQueue
        .then(() => services.savePendingEdits?.(command.edits))
        .catch((cause: unknown) => {
          console.error("Saving the pending AI edits failed", cause);
        });
    });
  });
}

/** What the room's socket reports to the link, frame by frame, in the order the relay sent them. */
export type RoomEvent =
  | { type: "room.welcome"; companion: string | undefined }
  | { type: "room.peer.joined"; peer: string; role: ConnectRole }
  | { type: "room.peer.left"; peer: string; role: ConnectRole }
  | {
      type: "room.hello";
      from: string;
      protocol: { min: number; max: number };
      companion: CompanionInfo | undefined;
      answerHello: boolean;
    }
  | { type: "room.message"; from: string; message: CompanionMessage }
  | { type: "room.busy"; busy: RelayBusyFrame }
  | { type: "room.quota"; quota: RelayQuotaFrame }
  | { type: "room.error"; code: string; message: string }
  | { type: "room.closed"; code: number; reason: string };

/** What the link asks of the room's socket: seal and send a hello or a message to one peer. */
export type RoomCommand =
  | { type: "room.hello.send"; peer: string }
  | { type: "room.message.send"; peer: string; message: CompanionMessage };

/** A pairing's room: its socket URL and subprotocols, and the channel that seals under its key. */
export interface LinkRoom {
  url: string;
  protocols: readonly string[];
  channel: SecureChannel;
}

/**
 * The room's socket
 *
 * Opens each sealed frame with the channel before the next, since opening is async and sequence checks need order,
 * and reports what it holds. Seals and sends what the link asks. It decides nothing about peers.
 */
function createRoomLogic(services: ConnectServices) {
  return fromCallback<RoomCommand, LinkRoom, RoomEvent>(({ input, sendBack, receive }) => {
    const { channel } = input;
    let frameQueue: Promise<void> = Promise.resolve();
    let isStopped = false;

    const report = (event: RoomEvent) => {
      if (!isStopped) {
        sendBack(event);
      }
    };

    const readFrame = async (text: string) => {
      const frame = parseRelayServerFrame(text);

      if (frame === undefined) {
        return;
      }

      switch (frame.t) {
        case "welcome":
          report({ type: "room.welcome", companion: frame.peers.find((peer) => peer.role === "companion")?.id });

          return;

        case "peer":
          report({
            type: frame.event === "join" ? "room.peer.joined" : "room.peer.left",
            peer: frame.peer.id,
            role: frame.peer.role,
          });

          return;

        case "data": {
          const opened = await channel.open(frame.from, frame.d);

          if (!opened.ok) {
            return;
          }

          if (opened.message.type === "hello") {
            report({
              type: "room.hello",
              from: frame.from,
              protocol: opened.message.protocol,
              companion: opened.message.companion,
              answerHello: opened.answerHello,
            });

            return;
          }

          report({ type: "room.message", from: frame.from, message: opened.message });

          return;
        }

        case "busy":
          report({ type: "room.busy", busy: frame });

          return;

        case "quota":
          report({ type: "room.quota", quota: frame });

          return;

        case "error":
          report({ type: "room.error", code: frame.code, message: frame.message });

          return;
      }
    };

    const socket = services.openSocket(
      input.url,
      {
        open: () => undefined,
        message: (text) => {
          frameQueue = frameQueue
            .then(() => readFrame(text))
            .catch((cause: unknown) => {
              console.error("Reading a relay frame failed", cause);
            });
        },
        close: (code, reason) => report({ type: "room.closed", code, reason }),
      },
      input.protocols,
    );

    const sendSealed = (peer: string, sealing: Promise<string>) => {
      void sealing.then(
        (sealed) => socket.send(JSON.stringify({ t: "send", to: peer, d: sealed })),
        (cause: unknown) => {
          console.error(`Sealing a message for peer ${peer} failed`, cause);
        },
      );
    };

    receive((command) => {
      if (command.type === "room.hello.send") {
        sendSealed(
          command.peer,
          channel.hello(command.peer, { type: "hello", role: "tab", protocol: { ...CONNECT_PROTOCOL } }),
        );

        return;
      }

      sendSealed(command.peer, channel.seal(command.peer, command.message));
    });

    return () => {
      isStopped = true;
      socket.close(1000, "Closed by the tab");
    };
  });
}

/** The link's context: its pairing secret, then the room it derived, and the companion it talks to. */
export interface LinkContext {
  secret: string;
  room: LinkRoom | undefined;
  /** The relay's id for the companion in the room, from its join until it leaves. */
  companion: string | undefined;
}

/** The link's id under the connect machine. */
export const LINK_ID = "link";

/**
 * The relay link: derives the keys, opens the room's socket, says hello to the companion, and passes on what it
 * says once it said hello back
 *
 * A send names its companion: one for a companion that is gone or has not said hello comes back as
 * `link.send.refused`, never sent to another. Reports `link.closed` once, when the socket closes or the keys cannot
 * be derived.
 */
export function createLinkMachine(services: ConnectServices) {
  return setup({
    types: {
      input: declareType<{ secret: string }>(),
      context: declareType<LinkContext>(),
      events: declareType<LinkCommand | RoomEvent>(),
    },
    actors: {
      deriveRoom: fromPromise<LinkRoom, { secret: string }>(async ({ input }) => {
        const keys = await deriveConnectKeys(input.secret, { iterations: services.kdfIterations });

        return {
          url: services.roomUrl(keys.roomId),
          protocols: roomProtocols(keys.roomProof),
          channel: new SecureChannel({ key: keys.key, role: "tab" }),
        };
      }),
      room: createRoomLogic(services),
    },
    guards: {
      isCompanionPeer: ({ event }) =>
        (event.type === "room.peer.joined" || event.type === "room.peer.left") && event.role === "companion",
      isFromCompanion: ({ context, event }) =>
        (event.type === "room.hello" || event.type === "room.message") && event.from === context.companion,
      isLeavingCompanion: ({ context, event }) =>
        event.type === "room.peer.left" && event.role === "companion" && event.peer === context.companion,
      isForCompanion: ({ context, event }) => event.type === "link.send" && event.peer === context.companion,
      sharesProtocol: ({ event }) =>
        event.type === "room.hello" && sharedProtocolVersion(CONNECT_PROTOCOL, event.protocol) !== undefined,
    },
    actions: {
      sendHello: sendTo("room", (_, params: { peer: string }): RoomCommand => ({
        type: "room.hello.send",
        peer: params.peer,
      })),
      forgetCompanion: enqueueActions(({ enqueue, context }) => {
        if (context.companion !== undefined) {
          context.room?.channel.forget(context.companion);
        }

        enqueue.assign({ companion: undefined });
      }),
      greet: enqueueActions(({ enqueue, event }) => {
        if (event.type !== "room.hello") {
          return;
        }

        if (event.answerHello) {
          enqueue.sendTo("room", { type: "room.hello.send", peer: event.from } satisfies RoomCommand);
        }

        enqueue.sendParent({
          type: "companion.greeted",
          peer: event.from,
          companion: event.companion,
        } satisfies LinkEvent);
      }),
      reportIncompatible: sendParent(({ event }): LinkEvent => {
        if (event.type !== "room.hello") {
          throw new Error(`Expected a room.hello event, but got '${event.type}'`);
        }

        return { type: "companion.incompatible", range: event.protocol };
      }),
      refuseSend: sendParent(({ event }): LinkEvent => {
        if (event.type !== "link.send") {
          throw new Error(`Expected a link.send event, but got '${event.type}'`);
        }

        return { type: "link.send.refused", peer: event.peer, message: event.message };
      }),
      reportClosed: sendParent(({ event }): LinkEvent => {
        if (event.type === "room.closed") {
          return { type: "link.closed", code: event.code, reason: event.reason };
        }

        return { type: "link.closed", code: 0, reason: "error" in event ? getErrorText(event.error) : "" };
      }),
    },
  }).createMachine({
    id: "link",
    initial: "deriving",
    context: ({ input }) => ({ secret: input.secret, room: undefined, companion: undefined }),
    on: {
      "link.send": { actions: "refuseSend" },
    },
    states: {
      deriving: {
        invoke: {
          src: "deriveRoom",
          input: ({ context }) => ({ secret: context.secret }),
          onDone: { target: "socketOpen", actions: assign({ room: ({ event }) => event.output }) },
          onError: { target: "closed", actions: "reportClosed" },
        },
      },
      socketOpen: {
        invoke: {
          id: "room",
          src: "room",
          input: ({ context }) => {
            if (context.room === undefined) {
              throw new Error("Expected a derived room before opening its socket");
            }

            return context.room;
          },
        },
        on: {
          "room.closed": { target: "closed", actions: "reportClosed" },
          "room.busy": { actions: sendParent(({ event }): LinkEvent => ({ type: "relay.busy", busy: event.busy })) },
          "room.quota": {
            actions: sendParent(({ event }): LinkEvent => ({ type: "relay.quota", quota: event.quota })),
          },
          "room.error": {
            actions: sendParent(({ event }): LinkEvent => ({
              type: "relay.error",
              code: event.code,
              message: event.message,
            })),
          },
        },
        initial: "connecting",
        states: {
          connecting: {
            on: {
              "room.welcome": {
                target: "welcomed",
                actions: [
                  sendParent({ type: "link.opened" } satisfies LinkEvent),
                  enqueueActions(({ enqueue, event }) => {
                    if (event.companion !== undefined) {
                      enqueue.raise({ type: "room.peer.joined", peer: event.companion, role: "companion" });
                    }
                  }),
                ],
              },
            },
          },
          welcomed: {
            initial: "alone",
            on: {
              "room.peer.joined": {
                guard: "isCompanionPeer",
                target: ".peerJoined",
                actions: [
                  enqueueActions(({ enqueue, context }) => {
                    if (context.companion !== undefined) {
                      enqueue.sendParent({ type: "companion.left" } satisfies LinkEvent);
                    }
                  }),
                  "forgetCompanion",
                  assign({ companion: ({ event }) => event.peer }),
                  { type: "sendHello", params: ({ event }) => ({ peer: event.peer }) },
                ],
              },
              "room.peer.left": {
                guard: "isLeavingCompanion",
                target: ".alone",
                actions: ["forgetCompanion", sendParent({ type: "companion.left" } satisfies LinkEvent)],
              },
            },
            states: {
              alone: {},
              /** The companion joined and this tab said hello: nothing but its hello comes through. */
              peerJoined: {
                on: {
                  "room.hello": [
                    { guard: and(["isFromCompanion", "sharesProtocol"]), target: "peerGreeted", actions: "greet" },
                    { guard: "isFromCompanion", actions: "reportIncompatible" },
                  ],
                },
              },
              peerGreeted: {
                on: {
                  "room.hello": [
                    { guard: and(["isFromCompanion", "sharesProtocol"]), actions: "greet" },
                    { guard: "isFromCompanion", target: "peerJoined", actions: "reportIncompatible" },
                  ],
                  "room.message": {
                    guard: "isFromCompanion",
                    actions: sendParent(({ event }): LinkEvent => ({
                      type: "companion.message",
                      peer: event.from,
                      message: event.message,
                    })),
                  },
                  "link.send": [
                    {
                      guard: "isForCompanion",
                      actions: sendTo("room", ({ event }): RoomCommand => ({
                        type: "room.message.send",
                        peer: event.peer,
                        message: event.message,
                      })),
                    },
                    { actions: "refuseSend" },
                  ],
                },
              },
            },
          },
        },
      },
      closed: { type: "final" },
    },
  });
}

/** The jobs queue's context: the jobs waiting, in order, and the one running. */
export interface JobsContext {
  queue: readonly QueuedJob[];
  running: QueuedJob | undefined;
}

/**
 * Tool calls and undos, one at a time, in the order they arrive
 *
 * An Undo still in the queue can be cancelled; once it runs, it settles.
 */
export function createJobsMachine(services: ConnectServices) {
  return setup({
    types: {
      context: declareType<JobsContext>(),
      events: declareType<Job>(),
    },
    actors: {
      executeTool: fromPromise<ConnectToolOutcome, ConnectToolRequest>(async ({ input, signal }) =>
        services.executeTool(input, signal),
      ),
      undoEdit: fromPromise<void, PendingEdit>(async ({ input }) => services.undoEdit(input)),
    },
    guards: {
      isToolNext: ({ context }) => context.queue[0]?.type === "tool.run",
      isUndoNext: ({ context }) => context.queue[0]?.type === "undo.run",
    },
    actions: {
      enqueue: assign({
        queue: ({ context, event }) => (event.type === "undo.cancel" ? context.queue : [...context.queue, event]),
      }),
      takeNext: assign({ running: ({ context }) => context.queue[0], queue: ({ context }) => context.queue.slice(1) }),
    },
  }).createMachine({
    id: "jobs",
    initial: "idle",
    context: { queue: [], running: undefined },
    on: {
      "tool.run": { actions: "enqueue" },
      "undo.run": { actions: "enqueue" },
      "undo.cancel": {
        actions: assign({
          queue: ({ context, event }) =>
            context.queue.filter((job) => job.type !== "undo.run" || job.edit.id !== event.id),
        }),
      },
    },
    states: {
      idle: {
        entry: assign({ running: undefined }),
        always: [
          { guard: "isToolNext", target: "runningTool", actions: "takeNext" },
          { guard: "isUndoNext", target: "runningUndo", actions: "takeNext" },
        ],
      },
      runningTool: {
        invoke: {
          src: "executeTool",
          input: ({ context }) => {
            if (context.running?.type !== "tool.run") {
              throw new Error(`Expected a tool call to run, but got '${context.running?.type}'`);
            }

            return context.running.request;
          },
          onDone: {
            target: "idle",
            actions: sendParent(({ context, event }): InternalEvent => toSettledTool(context.running, event.output)),
          },
          onError: {
            target: "idle",
            actions: sendParent(({ context, event }): InternalEvent =>
              toSettledTool(context.running, {
                ok: false,
                error: { code: "failed", message: getErrorText(event.error) },
              }),
            ),
          },
        },
      },
      runningUndo: {
        entry: sendParent(({ context }): InternalEvent => ({
          type: "undo.started",
          id: toUndoneEdit(context.running).id,
        })),
        invoke: {
          src: "undoEdit",
          input: ({ context }) => toUndoneEdit(context.running),
          onDone: {
            target: "idle",
            actions: sendParent(({ context }): InternalEvent => ({
              type: "undo.settled",
              id: toUndoneEdit(context.running).id,
            })),
          },
          onError: {
            target: "idle",
            actions: sendParent(({ context, event }): InternalEvent => ({
              type: "undo.settled",
              id: toUndoneEdit(context.running).id,
              error: getErrorText(event.error),
            })),
          },
        },
      },
    },
  });
}

function toSettledTool(running: QueuedJob | undefined, outcome: ConnectToolOutcome): InternalEvent {
  if (running?.type !== "tool.run") {
    throw new Error(`Expected a running tool call, but got '${running?.type}'`);
  }

  return { type: "tool.settled", request: running.request, peer: running.peer, outcome };
}

function toUndoneEdit(running: QueuedJob | undefined): PendingEdit {
  if (running?.type !== "undo.run") {
    throw new Error(`Expected a running Undo, but got '${running?.type}'`);
  }

  return running.edit;
}
