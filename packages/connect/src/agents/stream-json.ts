import * as z from "zod/mini";

import type { TurnEvent, TurnParser } from "./contract.ts";

/**
 * A reader of the Messages API `stream-json` lines that Claude Code (`--output-format stream-json`) and Grok
 * (`--output-format streaming-messages-json`) print, with partial messages on.
 */

/** How one CLI's stream differs: what its session may start with, and how it names a tool. */
export interface StreamJsonDialect {
  /** The CLI's name, for a failure without a message. */
  agentName: string;
  /** Why the session the `system` `init` line describes goes beyond the lockdown, or undefined when it does not. */
  checkInit(init: Record<string, unknown>): string | undefined;
  /**
   * The name to check for a tool block, or undefined for a block that calls nothing beyond the Drizzle Run tools
   * yet: one that only searches them, or whose input is still to come (`partial`, a block that just started).
   */
  getToolName(block: Record<string, unknown>, partial: boolean): string | undefined;
}

const StringListSchema = z.array(z.string());

/** A list of strings, or undefined when it is anything else. */
export function readStringList(value: unknown): string[] | undefined {
  const parsed = StringListSchema.safeParse(value);

  return parsed.success ? parsed.data : undefined;
}

/** An object the API sends, such as a content block: its type, and every other field as sent. */
const ApiObjectSchema = z.looseObject({ type: z.string() });

const SystemInitLineSchema = z.looseObject({ type: z.literal("system"), subtype: z.literal("init") });

const StreamEventLineSchema = z.looseObject({ type: z.literal("stream_event"), event: ApiObjectSchema });

const BlockStartSchema = z.looseObject({ type: z.literal("content_block_start"), content_block: ApiObjectSchema });

const TextDeltaSchema = z.looseObject({
  type: z.literal("content_block_delta"),
  delta: z.looseObject({ type: z.literal("text_delta"), text: z.string() }),
});

const AssistantLineSchema = z.looseObject({
  type: z.literal("assistant"),
  message: z.looseObject({ content: z.array(z.unknown()) }),
});

const TextBlockSchema = z.looseObject({ type: z.literal("text"), text: z.string() });

// A field of another type reads as left out, so a result line always ends the turn.
const ResultLineSchema = z.looseObject({
  type: z.literal("result"),
  is_error: z.catch(z.optional(z.boolean()), undefined),
  subtype: z.catch(z.optional(z.string()), undefined),
  result: z.catch(z.optional(z.string()), undefined),
});

/** Whether a content block calls a tool: a client tool, or one the API runs (web search, code execution). */
export function isToolBlock(block: Record<string, unknown>): boolean {
  return block.type === "tool_use" || block.type === "server_tool_use" || block.type === "mcp_tool_use";
}

/** A tool block's name; a tool the API runs keeps its type, so it never matches a Drizzle Run tool. */
export function getToolBlockName(block: Record<string, unknown>): string {
  const name = typeof block.name === "string" ? block.name : "unnamed";

  return block.type === "tool_use" ? name : `${String(block.type)}:${name}`;
}

/**
 * Create a reader for one turn's stream-json lines
 *
 * Text streams from the deltas; a whole `assistant` message carries it only when no delta did, so it is never
 * repeated. Throws on a line that is not JSON.
 */
export function createStreamJsonParser(dialect: StreamJsonDialect): TurnParser {
  let hasStreamed = false;

  return (line) => {
    const event: unknown = JSON.parse(line);
    const init = SystemInitLineSchema.safeParse(event);

    if (init.success) {
      const reason = dialect.checkInit(init.data);

      return reason === undefined ? [] : [{ kind: "unsafe", reason }];
    }

    const streamLine = StreamEventLineSchema.safeParse(event);

    if (streamLine.success) {
      return readStreamEvent(streamLine.data.event);
    }

    const assistant = AssistantLineSchema.safeParse(event);

    if (assistant.success) {
      return readAssistantMessage(assistant.data.message.content);
    }

    const result = ResultLineSchema.safeParse(event);

    if (!result.success) {
      return [];
    }

    const { is_error: isError, subtype } = result.data;

    if (isError === true || (subtype !== undefined && subtype !== "success")) {
      const error =
        result.data.result !== undefined && result.data.result !== ""
          ? result.data.result
          : `${dialect.agentName} stopped (${String(subtype)}).`;

      return [{ kind: "failed", error }];
    }

    return [{ kind: "finished" }];
  };

  function readStreamEvent(streamEvent: z.output<typeof ApiObjectSchema>): TurnEvent[] {
    const blockStart = BlockStartSchema.safeParse(streamEvent);

    if (blockStart.success && isToolBlock(blockStart.data.content_block)) {
      const name = dialect.getToolName(blockStart.data.content_block, true);

      return name === undefined ? [] : [{ kind: "tool", name }];
    }

    if (streamEvent.type === "message_start") {
      hasStreamed = false;
      return [{ kind: "message" }];
    }

    const textDelta = TextDeltaSchema.safeParse(streamEvent);

    if (textDelta.success) {
      hasStreamed = true;
      return [{ kind: "text", text: textDelta.data.delta.text }];
    }

    return [];
  }

  function readAssistantMessage(content: readonly unknown[]): TurnEvent[] {
    const blocks = content.flatMap((value) => {
      const block = ApiObjectSchema.safeParse(value);

      return block.success ? [block.data] : [];
    });
    const toolCalls = blocks.filter(isToolBlock).flatMap((block): TurnEvent[] => {
      const name = dialect.getToolName(block, false);

      return name === undefined ? [] : [{ kind: "tool", name }];
    });

    if (toolCalls.length > 0) {
      return toolCalls;
    }

    // Without partial messages (or when a CLI version skips them), the whole message carries the text.
    if (hasStreamed) {
      return [];
    }

    const texts = blocks.flatMap((block) => {
      const text = TextBlockSchema.safeParse(block);

      return text.success ? [text.data.text] : [];
    });

    return texts.length > 0 ? [{ kind: "message" }, { kind: "text", text: texts.join("") }] : [];
  }
}
