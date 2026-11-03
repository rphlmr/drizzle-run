import * as z from "zod/mini";

import { createPlainObjectSchema, keepIfValid, refined } from "../shared/schema.ts";
import {
  AGENT_EFFORTS,
  AGENT_IDS,
  AGENT_MODEL_ID_PATTERN,
  CONNECT_LIMITS,
  CONNECT_ROLES,
  type AgentModel,
  type AgentTuning,
  type ChatContextEntry,
  type ChatMode,
  type ChatProject,
  type ChatProjectSide,
  type CompanionAgent,
  type CompanionInfo,
  type ConnectMessage,
  type RelayClientFrame,
  type RelayErrorCode,
  type RelayPeer,
  type RelayServerFrame,
  type ToolErrorCode,
  type TurnState,
} from "./protocol.ts";
import { CONNECT_TOOL_SCOPES, isConnectToolName, type ConnectToolName, type ConnectToolScope } from "./tools.ts";

/**
 * Readers for what arrives over the link. Everything is checked field by field, since a
 * sealed message comes from the other side and a relay frame from the network.
 */

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const MODES: readonly ChatMode[] = ["ask", "edit"];

const TURN_STATES: readonly TurnState[] = ["started", "done", "failed", "stopped"];

const TOOL_ERROR_CODES: readonly ToolErrorCode[] = [
  "invalid_input",
  "unknown_tool",
  "edit_mode_required",
  "no_project",
  "not_found",
  "conflict",
  "unavailable",
  "busy",
  "failed",
  "timeout",
  "no_tab",
];

const RELAY_ERRORS: readonly RelayErrorCode[] = ["rate_limited", "too_large", "bad_frame", "no_peer"];

const PlainObjectSchema = createPlainObjectSchema();

/** Text of at most `maxLength` characters. */
function boundedText(maxLength = 1_000_000) {
  return z.string().check(z.maxLength(maxLength));
}

const IdSchema = z.string().check(z.regex(ID_PATTERN));
const RoleSchema = z.enum(CONNECT_ROLES);
const AgentIdSchema = z.enum(AGENT_IDS);

const ProtocolRangeSchema = z.object({ min: z.int(), max: z.int() }).check(z.refine((range) => range.min <= range.max));

const ModelIdSchema = z.string().check(z.regex(AGENT_MODEL_ID_PATTERN));
const EffortSchema = z.enum(AGENT_EFFORTS);
const EffortsSchema = z.array(EffortSchema).check(z.maxLength(AGENT_EFFORTS.length));

const AgentModelSchema = z.object({
  id: ModelIdSchema,
  name: boundedText(80),
  efforts: EffortsSchema,
}) satisfies z.ZodMiniType<AgentModel>;

const AgentTuningSchema = z.pipe(
  z.object({ model: z.optional(ModelIdSchema), effort: z.optional(EffortSchema) }),
  z.transform(({ model, effort }): AgentTuning => ({
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  })),
);

/** The chat so far: at most `maxChatContextEntries` entries, with at most `maxChatContextChars` of text in all. */
const ChatContextSchema = z.array(z.object({ from: z.enum(["user", "agent"]), text: z.string() })).check(
  z.maxLength(CONNECT_LIMITS.maxChatContextEntries),
  z.refine(
    (entries) => entries.reduce((total, entry) => total + entry.text.length, 0) <= CONNECT_LIMITS.maxChatContextChars,
  ),
) satisfies z.ZodMiniType<readonly ChatContextEntry[]>;

const CompanionAgentSchema = z.pipe(
  z.object({
    id: AgentIdSchema,
    name: boundedText(80),
    version: keepIfValid(boundedText(80)),
    models: keepIfValid(z.array(AgentModelSchema).check(z.maxLength(40))),
    defaults: keepIfValid(AgentTuningSchema),
  }),
  z.transform(({ id, name, version, models, defaults }): CompanionAgent => ({
    id,
    name,
    ...(version === undefined ? {} : { version }),
    ...(models === undefined ? {} : { models }),
    ...(defaults === undefined ? {} : { defaults }),
  })),
);

const CompanionInfoSchema = z.pipe(
  z.object({
    version: boundedText(40),
    mode: z.enum(["chat", "mcp"]),
    agents: z.array(CompanionAgentSchema),
    agent: keepIfValid(AgentIdSchema),
  }),
  z.transform(({ version, mode, agents, agent }): CompanionInfo => ({
    version,
    mode,
    agents,
    ...(agent === undefined ? {} : { agent }),
  })),
);

function createChatProjectSideSchema<const Side extends 0 | 1>(side: Side) {
  return z.object({
    side: z.literal(side),
    name: boundedText(40),
    orm: boundedText(40),
    database: z.optional(keepIfValid(boundedText(40))),
  }) satisfies z.ZodMiniType<ChatProjectSide>;
}

/** A side-by-side project's two sides; malformed sides are left out of the project. */
const ChatProjectSidesSchema = z.tuple([createChatProjectSideSchema(0), createChatProjectSideSchema(1)]);

/** The project a chat turn is about; a malformed project is left out of the turn. */
const ChatProjectSchema = z.pipe(
  z.object({
    id: boundedText(200),
    name: boundedText(200),
    sides: keepIfValid(ChatProjectSidesSchema),
    origin: z.optional(z.unknown()),
  }),
  z.transform(({ id, name, sides, origin }): ChatProject => ({
    id,
    name,
    ...(sides === undefined ? {} : { sides }),
    ...(origin === "community" ? { origin: "community" as const } : {}),
  })),
);

const ToolNameSchema = refined<ConnectToolName>(isConnectToolName);

const ToolResultSchema = z.discriminatedUnion("ok", [
  z.pipe(
    z.object({ type: z.literal("tool.result"), id: IdSchema, ok: z.literal(true), result: z.optional(z.unknown()) }),
    z.transform(({ id, result }) => ({ type: "tool.result" as const, id, ok: true as const, result })),
  ),
  z.object({
    type: z.literal("tool.result"),
    id: IdSchema,
    ok: z.literal(false),
    // A newer peer may send a code this version does not know; it still reads as a failure.
    error: z.object({
      code: z.pipe(
        boundedText(40),
        z.transform((code): ToolErrorCode => (isToolErrorCode(code) ? code : "failed")),
      ),
      message: boundedText(4000),
    }),
  }),
]);

/** A sealed message's content; each type keeps only its own fields. */
const ConnectMessageSchema = z.pipe(
  PlainObjectSchema,
  z.discriminatedUnion("type", [
    z.pipe(
      z.object({
        type: z.literal("hello"),
        role: RoleSchema,
        protocol: ProtocolRangeSchema,
        companion: z.optional(CompanionInfoSchema),
      }),
      z.transform(({ role, protocol, companion }) => ({
        type: "hello" as const,
        role,
        protocol,
        ...(companion === undefined ? {} : { companion }),
      })),
    ),
    z.object({ type: z.literal(["forget", "forgotten", "tab.active"]) }),
    z.object({ type: z.literal(["agent.choose", "agent.chosen"]), agent: AgentIdSchema }),
    z.pipe(
      z.object({
        type: z.literal("chat.send"),
        conversation: IdSchema,
        text: boundedText(100_000),
        mode: z.enum(MODES),
        project: keepIfValid(ChatProjectSchema),
        // A scope from a newer tab gets the read-only tools of an untrusted project, never the full project tools.
        scope: z.union([z.optional(z.enum(CONNECT_TOOL_SCOPES)), z.transform((): ConnectToolScope => "untrusted")]),
        agent: z.optional(AgentIdSchema),
        model: z.optional(ModelIdSchema),
        effort: z.optional(EffortSchema),
        context: z.optional(ChatContextSchema),
      }),
      z.transform(({ conversation, text, mode, project, scope, agent, model, effort, context }) => ({
        type: "chat.send" as const,
        conversation,
        text,
        mode,
        ...(project === undefined ? {} : { project }),
        ...(scope === undefined ? {} : { scope }),
        ...(agent === undefined ? {} : { agent }),
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
        ...(context === undefined ? {} : { context }),
      })),
    ),
    z.object({ type: z.literal("chat.stop"), conversation: IdSchema }),
    z.object({ type: z.literal("agent.text"), conversation: IdSchema, turn: IdSchema, text: boundedText() }),
    z.pipe(
      z.object({
        type: z.literal("agent.turn"),
        conversation: IdSchema,
        turn: IdSchema,
        state: z.enum(TURN_STATES),
        error: keepIfValid(boundedText(4000)),
      }),
      z.transform(({ conversation, turn, state, error }) => ({
        type: "agent.turn" as const,
        conversation,
        turn,
        state,
        ...(error === undefined ? {} : { error }),
      })),
    ),
    z.pipe(
      z.object({
        type: z.literal("tool.call"),
        id: IdSchema,
        name: ToolNameSchema,
        input: z.optional(z.unknown()),
        conversation: keepIfValid(IdSchema),
      }),
      z.transform(({ id, name, input, conversation }) => ({
        type: "tool.call" as const,
        id,
        name,
        input: input ?? {},
        ...(conversation === undefined ? {} : { conversation }),
      })),
    ),
    ToolResultSchema,
  ]),
) satisfies z.ZodMiniType<ConnectMessage>;

/** A tool call this version cannot run, read so the tab can answer it instead of dropping it. */
const UnknownToolCallSchema = z.pipe(
  PlainObjectSchema,
  z.object({
    type: z.literal("tool.call"),
    id: IdSchema,
    name: boundedText(100).check(z.refine((name) => !isConnectToolName(name))),
    conversation: keepIfValid(IdSchema),
  }),
);
const UnknownToolCallMessageSchema = z.pipe(
  UnknownToolCallSchema,
  z.transform(({ id, name, conversation }) => ({
    type: "tool.unknown" as const,
    id,
    name,
    ...(conversation === undefined ? {} : { conversation }),
  })),
);

/**
 * Read a sealed message's content
 *
 * Returns undefined when it is not a message this version knows or a field is invalid.
 */
export function readConnectMessage(value: unknown): ConnectMessage | undefined {
  const message = ConnectMessageSchema.safeParse(value);

  if (message.success) {
    return message.data;
  }

  const unknownToolCall = UnknownToolCallMessageSchema.safeParse(value);

  return unknownToolCall.success ? unknownToolCall.data : undefined;
}

/** Check whether a value is a tool error code this version knows. */
export function isToolErrorCode(value: unknown): value is ToolErrorCode {
  return TOOL_ERROR_CODES.some((code) => code === value);
}

const IsoTimeSchema = boundedText(40).check(z.refine((time) => !Number.isNaN(Date.parse(time))));

const RelayPeerSchema = z.object({ id: IdSchema, role: RoleSchema }) satisfies z.ZodMiniType<RelayPeer>;

/** A frame the relay sends a client. */
const RelayServerFrameSchema = z.pipe(
  PlainObjectSchema,
  z.discriminatedUnion("t", [
    z.object({
      t: z.literal("welcome"),
      id: IdSchema,
      role: RoleSchema,
      peers: z.array(RelayPeerSchema),
      maxFrameBytes: z.int(),
    }),
    z.object({ t: z.literal("peer"), event: z.enum(["join", "leave"]), peer: RelayPeerSchema }),
    z.object({ t: z.literal("data"), from: IdSchema, d: boundedText() }),
    z.object({
      t: z.literal("busy"),
      scope: z.enum(["daily", "room"]),
      retryAt: IsoTimeSchema,
    }),
    z.object({
      t: z.literal("quota"),
      per: z.enum(["account", "connection"]),
      used: z.int().check(z.nonnegative()),
      limit: z.int().check(z.nonnegative()),
      resetAt: IsoTimeSchema,
    }),
    z.object({ t: z.literal("error"), code: z.enum(RELAY_ERRORS), message: boundedText(400) }),
  ]),
) satisfies z.ZodMiniType<RelayServerFrame>;

/** A frame a client sends the relay: only `send` frames exist. */
const RelayClientFrameSchema = z.pipe(
  PlainObjectSchema,
  z.pipe(
    z.object({ t: z.literal("send"), d: boundedText(), to: z.optional(IdSchema) }),
    z.transform(({ d, to }): RelayClientFrame => ({ t: "send", d, ...(to === undefined ? {} : { to }) })),
  ),
);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Parse a frame the relay sent; undefined when it is not valid JSON or not a known frame. */
export function parseRelayServerFrame(text: string): RelayServerFrame | undefined {
  const frame = RelayServerFrameSchema.safeParse(parseJson(text));

  return frame.success ? frame.data : undefined;
}

/** Parse a frame a client sent the relay; undefined when it is not a valid `send` frame. */
export function parseRelayClientFrame(text: string): RelayClientFrame | undefined {
  const frame = RelayClientFrameSchema.safeParse(parseJson(text));

  return frame.success ? frame.data : undefined;
}
