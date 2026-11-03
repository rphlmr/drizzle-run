import {
  createRunController,
  createComparisonController,
  createRuntimeComparisonController,
  type RuntimeComparisonOptions,
  type RunController,
  type RunControllerOptions,
  type RunOutcome,
  type RunState,
  type ComparisonController,
  type ComparisonOptions,
  type ComparisonOutcome,
  type ComparisonState,
  type Subscription,
} from "@drizzle-run/orchestration";
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useEffectEvent,
  useInsertionEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type ReactElement,
} from "react";

export interface StateStore<State> {
  getState(): State;
  subscribe(listener: (state: State) => void): Subscription;
}

function createSelectionReader<State, Selection>(
  controller: StateStore<State>,
  selector: (state: State) => Selection,
  compare: (left: Selection, right: Selection) => boolean,
) {
  let cached: { state: State; selection: Selection } | undefined;

  return () => {
    const state = controller.getState();

    if (cached !== undefined && Object.is(cached.state, state)) {
      return cached.selection;
    }

    const next = selector(state);
    const selection = cached !== undefined && compare(cached.selection, next) ? cached.selection : next;
    cached = { state, selection };

    return selection;
  };
}

/** Subscribe to a controller's plain state, with an optional selector and equality check. */
export function useControllerSelector<State, Selection>(
  controller: StateStore<State>,
  selector: (state: State) => Selection,
  compare: (left: Selection, right: Selection) => boolean = Object.is,
): Selection {
  const readSelection = useMemo(
    () => createSelectionReader(controller, selector, compare),
    [controller, selector, compare],
  );
  const subscribe = useMemo(
    () => (notify: () => void) => {
      const subscription = controller.subscribe(notify);

      return () => subscription.unsubscribe();
    },
    [controller],
  );

  return useSyncExternalStore(subscribe, readSelection, readSelection);
}

/** Read a controller without depending on a context provider. */
export function useControllerState<State>(controller: StateStore<State>): State {
  return useControllerSelector(controller, (state) => state);
}

function useOwnedController<Controller extends { cancel(): Promise<void>; dispose(): Promise<void> }>(
  create: () => Controller,
): Controller {
  const [controller] = useState(create);
  const mount = useRef<object | undefined>(undefined);
  const lifetime = useRef<"retained" | "unmounted">("retained");

  // Activity disconnects passive and layout effects, but retains insertion effects until real unmount.
  useInsertionEffect(
    () => () => {
      lifetime.current = "unmounted";
      queueMicrotask(() => {
        void controller.dispose().catch((cause) => {
          console.error("Disposing the execution controller failed.", cause);
        });
      });
    },
    [controller],
  );

  useEffect(() => {
    const current = {};
    mount.current = current;

    return () => {
      // StrictMode reconnects immediately; a hidden Activity cancels work while retaining its controller.
      queueMicrotask(() => {
        if (mount.current === current && lifetime.current === "retained") {
          void controller.cancel().catch((cause) => {
            console.error("Cancelling the execution controller failed.", cause);
          });
        }
      });
    };
  }, [controller]);

  return controller;
}

/** Own a run controller for this component's lifetime. Options are read once; the runtime remains caller-owned. */
export function useRunController(options: RunControllerOptions = {}): RunController {
  return useOwnedController(() => createRunController(options));
}

/** Own a comparison controller. Callbacks and execution policy are read once. */
export function useComparisonController(options: ComparisonOptions): ComparisonController {
  return useOwnedController(() => createComparisonController(options));
}

/** Own optional comparison history while the runtime owns both execution children. */
export function useRuntimeComparisonController(options: RuntimeComparisonOptions): ComparisonController {
  return useOwnedController(() => createRuntimeComparisonController(options));
}

const RunContext = createContext<RunController | null>(null);
const ComparisonContext = createContext<ComparisonController | null>(null);

export interface RunProviderProps {
  controller: RunController;
  children?: ReactNode;
}

export interface ComparisonProviderProps {
  controller: ComparisonController;
  children?: ReactNode;
}

/** Share a caller-owned run controller with descendants. */
export function RunProvider({ controller, children }: RunProviderProps): ReactElement {
  return createElement(RunContext.Provider, { value: controller }, children);
}

/** Share a caller-owned comparison controller with descendants. */
export function ComparisonProvider({ controller, children }: ComparisonProviderProps): ReactElement {
  return createElement(ComparisonContext.Provider, { value: controller }, children);
}

export function useRunActions(): RunController {
  const controller = useContext(RunContext);

  if (controller === null) {
    throw new Error("Render run hooks inside RunProvider.");
  }

  return controller;
}

export function useComparisonActions(): ComparisonController {
  const controller = useContext(ComparisonContext);

  if (controller === null) {
    throw new Error("Render comparison hooks inside ComparisonProvider.");
  }

  return controller;
}

export function useRunSelector<Selection>(
  selector: (state: RunState) => Selection,
  compare?: (left: Selection, right: Selection) => boolean,
): Selection {
  return useControllerSelector(useRunActions(), selector, compare);
}

export function useRunState(): RunState {
  return useControllerState(useRunActions());
}

export function useRunInProgress(): boolean {
  return useRunSelector((state) => state.status === "running" || state.status === "disposing");
}

export function useComparisonState(): ComparisonState {
  return useControllerState(useComparisonActions());
}

/** Observe completed submissions using the latest callback. */
export function useRunSettled(listener: (outcome: RunOutcome) => void): void {
  const controller = useRunActions();
  const onSettled = useEffectEvent(listener);

  useEffect(() => {
    const subscription = controller.onSettled(onSettled);

    return () => subscription.unsubscribe();
  }, [controller]);
}

/** Observe completed comparisons using the latest callback. */
export function useComparisonSettled(listener: (outcome: ComparisonOutcome) => void): void {
  const controller = useComparisonActions();
  const onSettled = useEffectEvent(listener);

  useEffect(() => {
    const subscription = controller.onSettled(onSettled);

    return () => subscription.unsubscribe();
  }, [controller]);
}
