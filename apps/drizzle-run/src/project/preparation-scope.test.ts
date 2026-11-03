import { describe, expect, it, vi } from "vitest";

import { createProjectPreparationRegistry } from "./preparation-scope";

describe("project preparation resource ownership", () => {
  it("should dispose completed resources when the component owner unmounts", () => {
    const registry = createProjectPreparationRegistry();
    const actorLifetime = new AbortController();
    const scope = registry.create(actorLifetime.signal);
    const disposeEditor = vi.fn();
    const disposeRuntime = vi.fn();

    scope.own(disposeEditor);
    scope.own(disposeRuntime);
    registry.dispose();

    expect(scope.signal.aborted).toBe(true);
    expect(scope.disposed).toBe(true);
    expect(disposeEditor).toHaveBeenCalledOnce();
    expect(disposeRuntime).toHaveBeenCalledOnce();
  });

  it("should dispose resources once when actor cancellation and owner cleanup overlap", () => {
    const registry = createProjectPreparationRegistry();
    const actorLifetime = new AbortController();
    const scope = registry.create(actorLifetime.signal);
    const disposeResource = vi.fn();

    scope.own(disposeResource);
    actorLifetime.abort();
    registry.dispose();
    scope.dispose();

    expect(scope.disposed).toBe(true);
    expect(disposeResource).toHaveBeenCalledOnce();
  });

  it("should immediately dispose a resource acquired after cancellation", () => {
    const registry = createProjectPreparationRegistry();
    const actorLifetime = new AbortController();
    const scope = registry.create(actorLifetime.signal);
    const disposeLateResource = vi.fn();

    actorLifetime.abort();
    scope.own(disposeLateResource);

    expect(scope.signal.aborted).toBe(true);
    expect(disposeLateResource).toHaveBeenCalledOnce();
  });

  it("should keep the registry usable for a readiness retry after a failed preparation", () => {
    const registry = createProjectPreparationRegistry();
    const first = registry.create(new AbortController().signal);
    const disposeFailedPreparation = vi.fn();
    first.own(disposeFailedPreparation);
    first.dispose();

    const retry = registry.create(new AbortController().signal);
    const disposeRetry = vi.fn();
    retry.own(disposeRetry);
    registry.dispose();

    expect(disposeFailedPreparation).toHaveBeenCalledOnce();
    expect(disposeRetry).toHaveBeenCalledOnce();
  });

  it("should reject resource ownership acquired after the component registry is disposed", () => {
    const registry = createProjectPreparationRegistry();
    registry.dispose();

    const lateScope = registry.create(new AbortController().signal);
    const disposeLateResource = vi.fn();
    lateScope.own(disposeLateResource);

    expect(lateScope.disposed).toBe(true);
    expect(lateScope.signal.aborted).toBe(true);
    expect(disposeLateResource).toHaveBeenCalledOnce();
  });
});
