import type { createGuideMachine } from "@drizzle-run/runtime/machines";
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useEffectEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import type { ActorRefFrom } from "xstate";

type GuideActor = ActorRefFrom<ReturnType<typeof createGuideMachine>>;
const GuideContext = createContext<GuideActor | null>(null);

function Provider({
  actor,
  onError,
  children,
}: {
  actor: GuideActor;
  onError?: (cause: unknown) => void;
  children?: ReactNode;
}): ReactElement {
  const reportError = useEffectEvent((cause: unknown) => onError?.(cause));

  useEffect(() => {
    const subscription = actor.subscribe({ error: reportError });

    return () => subscription.unsubscribe();
  }, [actor]);

  return createElement(GuideContext.Provider, { value: actor }, children);
}

function useActorRef(): GuideActor {
  const actor = useContext(GuideContext);

  if (actor === null) {
    throw new Error("Render guide hooks inside GuideProvider.");
  }

  return actor;
}

export const guideScope = { Provider, useActorRef };
