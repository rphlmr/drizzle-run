/** One preparation attempt: its signal, and the resources it disposes once. */
export interface ProjectPreparationScope {
  readonly signal: AbortSignal;
  readonly disposed: boolean;
  own(dispose: () => void): void;
  dispose: () => void;
}

/** The preparation attempts of a component, disposed with it. */
export interface ProjectPreparationRegistry {
  create(parentSignal: AbortSignal): ProjectPreparationScope;
  dispose(): void;
}

/** Creates a registry whose scopes dispose their resources when cancelled or when the registry is disposed. */
export function createProjectPreparationRegistry(): ProjectPreparationRegistry {
  const scopes = new Set<ProjectPreparationScope>();
  let closed = false;

  return {
    create(parentSignal) {
      const controller = new AbortController();
      const disposers = new Set<() => void>();
      let disposed = false;

      const scope: ProjectPreparationScope = {
        signal: controller.signal,
        get disposed() {
          return disposed;
        },
        own(dispose) {
          if (disposed) {
            dispose();
            return;
          }

          disposers.add(dispose);
        },
        dispose() {
          if (disposed) {
            return;
          }

          disposed = true;
          parentSignal.removeEventListener("abort", disposeFromParent);
          controller.abort();
          scopes.delete(scope);

          let firstError: unknown;
          let hasError = false;

          for (const dispose of disposers) {
            try {
              dispose();
            } catch (cause) {
              if (!hasError) {
                firstError = cause;
                hasError = true;
              }
            }
          }

          disposers.clear();

          if (hasError) {
            throw firstError;
          }
        },
      };

      const disposeFromParent = () => scope.dispose();

      scopes.add(scope);

      if (closed || parentSignal.aborted) {
        scope.dispose();
      } else {
        parentSignal.addEventListener("abort", disposeFromParent, { once: true });
      }

      return scope;
    },
    dispose() {
      if (closed) {
        return;
      }

      closed = true;
      let firstError: unknown;
      let hasError = false;

      for (const scope of Array.from(scopes)) {
        try {
          scope.dispose();
        } catch (cause) {
          if (!hasError) {
            firstError = cause;
            hasError = true;
          }
        }
      }

      if (hasError) {
        throw firstError;
      }
    },
  };
}
