/**
 * Startup resources to release on exit
 *
 * The companion makes a folder and a socket while it starts, and Ctrl+C may come at any point of that. `track` records
 * a resource as soon as its creation begins, so `release` waits for one still being made, then releases it. A
 * creation that fails has nothing to release. Releases run newest first and never throw: the process is exiting.
 */
export function createStartupResources() {
  const releases: (() => Promise<void>)[] = [];

  return {
    /** Record a resource being created, with how to release it. Returns the creation unchanged. */
    track<Resource>(creation: Promise<Resource>, release: (resource: Resource) => Promise<unknown>): Promise<Resource> {
      releases.push(async () => {
        const created = await creation.then(
          (resource) => ({ ok: true as const, resource }),
          () => ({ ok: false as const }),
        );

        if (created.ok) {
          await release(created.resource).catch(() => undefined);
        }
      });

      return creation;
    },

    /** Release every tracked resource, waiting for those still being created. */
    async release(): Promise<void> {
      for (const releaseOne of releases.splice(0).toReversed()) {
        await releaseOne();
      }
    },
  };
}
