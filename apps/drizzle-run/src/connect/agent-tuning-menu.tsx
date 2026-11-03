import {
  AGENT_EFFORTS,
  AGENT_IDS,
  AGENT_NAMES,
  fitAgentTuning,
  getAgentEfforts,
  type AgentEffort,
  type AgentTuning,
  type CompanionAgent,
  type CompanionInfo,
} from "@drizzle-run/core/connect";
import { attempt } from "es-toolkit";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";
import * as z from "zod/mini";

import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import type { ChatTuning } from "./chat-history";
import type { ChatHistoryState } from "./use-chat-history";

/**
 * The agent, model and effort picker of the chat composer.
 *
 * Each chat keeps its own choice in its history, set by its first message or a pick, so another chat's pick never
 * changes it. A chat without one starts on the last pick anywhere in this browser, kept in `localStorage`, else on
 * the agent's defaults. Nothing of it leaves this browser but the choice each message carries to the companion.
 */

const LAST_PICK_KEY = "drizzle-run:chat-tuning";

const EFFORT_LABELS: Record<AgentEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

const AgentIdSchema = z.enum(AGENT_IDS);

const LastPickSchema = z.object({
  agent: z.catch(z.optional(AgentIdSchema), undefined),
  byAgent: z.catch(
    z.partialRecord(
      AgentIdSchema,
      z.object({ model: z.optional(z.string()), effort: z.optional(z.enum(AGENT_EFFORTS)) }),
    ),
    {},
  ),
});

/** The last pick anywhere in this browser: the agent, and each agent's model and effort. */
export type LastPick = z.output<typeof LastPickSchema>;

const NO_PICK: LastPick = { byAgent: {} };

/** The last pick, or none when storage is refused or holds something else. */
function readLastPick(): LastPick {
  const [, stored] = attempt((): unknown => JSON.parse(window.localStorage.getItem(LAST_PICK_KEY) ?? "{}"));
  const saved = LastPickSchema.safeParse(stored);

  return saved.success ? saved.data : NO_PICK;
}

/**
 * Resolve a model and effort against what the agent offers now
 *
 * A stale effort is dropped; a model the agent no longer offers, or no choice, falls back to the agent's defaults. An
 * agent that offers no model resolves to nothing, so its CLI runs on its own defaults.
 */
function resolveAgentChoice(agent: CompanionAgent, saved: AgentTuning | undefined): AgentTuning {
  const savedTuning = saved === undefined ? {} : fitAgentTuning(agent, saved);

  return savedTuning.model === undefined ? fitAgentTuning(agent, agent.defaults ?? {}) : savedTuning;
}

/**
 * Resolve what a chat runs on
 *
 * The chat's own agent when the companion offers it, else the last picked agent, else the companion's. Its model and
 * effort are the chat's when the agent is the chat's, else that agent's last pick, each checked against what it
 * offers. Returns undefined when the companion offers no agent.
 */
export function resolveChatTuning(
  companion: Pick<CompanionInfo, "agents" | "agent">,
  chat: ChatTuning | undefined,
  last: LastPick,
): ChatTuning | undefined {
  const agent = [chat?.agent, last.agent, companion.agent]
    .map((id) => companion.agents.find((offered) => offered.id === id))
    .find((offered) => offered !== undefined);

  if (agent === undefined) {
    return undefined;
  }

  const saved = chat?.agent === agent.id ? chat : last.byAgent[agent.id];

  return { agent: agent.id, ...resolveAgentChoice(agent, saved) };
}

/** What a chat runs on once moved to another agent: that agent's last pick, else its defaults. */
function getAgentStart(agent: CompanionAgent, last: LastPick): ChatTuning {
  return { agent: agent.id, ...resolveAgentChoice(agent, last.byAgent[agent.id]) };
}

/** Pick the effort to keep on a model: the current one if it takes it, else the agent's default if it takes that. */
function getEffortForModel(agent: CompanionAgent, model: string, current: AgentEffort | undefined) {
  const efforts = getAgentEfforts(agent, model);

  return [current, agent.defaults?.effort].find((effort) => effort !== undefined && efforts.includes(effort));
}

/**
 * A chat's agent, model and effort
 *
 * Returns what the chat runs on (see `resolveChatTuning`), the last pick, and a setter that keeps a pick in the chat
 * and as the last pick for chats without one.
 */
export function useChatTuning(
  companion: CompanionInfo | undefined,
  history: Pick<ChatHistoryState, "tuning" | "setTuning">,
): { tuning: ChatTuning | undefined; last: LastPick; pick: (tuning: ChatTuning) => void } {
  const [last, setLast] = useState(readLastPick);
  const tuning = companion === undefined ? undefined : resolveChatTuning(companion, history.tuning, last);

  const pick = (next: ChatTuning) => {
    const nextLast: LastPick = {
      agent: next.agent,
      byAgent: {
        ...last.byAgent,
        [next.agent]: {
          ...(next.model === undefined ? {} : { model: next.model }),
          ...(next.effort === undefined ? {} : { effort: next.effort }),
        },
      },
    };

    history.setTuning(next);
    setLast(nextLast);

    attempt(() => window.localStorage.setItem(LAST_PICK_KEY, JSON.stringify(nextLast)));
  };

  return { tuning, last, pick };
}

/** The trigger's text, such as "Opus · High"; the agent's name when it offers no model. */
function getTuningLabel(agent: CompanionAgent, tuning: ChatTuning): string {
  if (tuning.model === undefined) {
    return AGENT_NAMES[agent.id];
  }

  const modelName = agent.models?.find((option) => option.id === tuning.model)?.name ?? tuning.model;

  return tuning.effort === undefined ? modelName : `${modelName} · ${EFFORT_LABELS[tuning.effort]}`;
}

/**
 * Agent, model and effort menu
 *
 * Lists the agents when the companion offers more than one; a chat moved to another agent hands it the chat so far
 * on its next message. Picking a model keeps the effort when that model takes it, else the agent's default effort.
 * Hidden when there is nothing to pick.
 */
export function AgentTuningMenu({
  agents,
  tuning,
  last,
  disabled,
  onChange,
}: {
  agents: readonly CompanionAgent[];
  tuning: ChatTuning;
  last: LastPick;
  disabled: boolean;
  onChange: (tuning: ChatTuning) => void;
}) {
  const agent = agents.find((offered) => offered.id === tuning.agent);
  const models = agent?.models ?? [];

  if (agent === undefined || (agents.length < 2 && models.length === 0)) {
    return null;
  }

  const { model, effort } = tuning;
  const efforts = getAgentEfforts(agent, model);
  const chooseAgent = (value: string) => {
    const nextAgent = agents.find((offered) => offered.id === value);

    if (nextAgent !== undefined && nextAgent.id !== agent.id) {
      onChange(getAgentStart(nextAgent, last));
    }
  };
  const chooseModel = (nextModel: string) => {
    const nextEffort = getEffortForModel(agent, nextModel, effort);

    onChange({ agent: agent.id, model: nextModel, ...(nextEffort === undefined ? {} : { effort: nextEffort }) });
  };
  const chooseEffort = (value: string) => {
    const nextEffort = efforts.find((option) => option === value);

    onChange({ ...tuning, ...(nextEffort === undefined ? {} : { effort: nextEffort }) });
  };
  const label = getTuningLabel(agent, tuning);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        render={
          <Button
            variant="ghost"
            className="relative h-6.5 min-h-6.5 min-w-0 gap-1 px-2 text-[12px] font-semibold text-muted after:absolute after:inset-x-0 after:-inset-y-2.25"
            aria-label={`Agent, model and effort: ${AGENT_NAMES[agent.id]}, ${label}`}
          />
        }
      >
        <span className="truncate">{label}</span>
        <ChevronDownIcon className="size-3 shrink-0 stroke-[2.4]" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="w-auto">
        {agents.length > 1 && (
          <DropdownMenuGroup>
            <DropdownMenuLabel>Agent</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={agent.id} onValueChange={chooseAgent}>
              {agents.map((option) => (
                <DropdownMenuRadioItem key={option.id} value={option.id} closeOnClick>
                  {AGENT_NAMES[option.id]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        )}
        {agents.length > 1 && models.length > 0 && <DropdownMenuSeparator />}
        {model !== undefined && models.length > 0 && (
          <DropdownMenuGroup>
            <DropdownMenuLabel>Model</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={model} onValueChange={chooseModel}>
              {models.map((option) => (
                <DropdownMenuRadioItem key={option.id} value={option.id} closeOnClick>
                  {option.name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        )}
        {efforts.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Effort</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={effort ?? ""} onValueChange={chooseEffort}>
                {efforts.map((option) => (
                  <DropdownMenuRadioItem key={option} value={option} closeOnClick>
                    {EFFORT_LABELS[option]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
