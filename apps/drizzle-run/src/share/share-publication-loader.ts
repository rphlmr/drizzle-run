import type { PlaygroundSnapshot } from "@drizzle-run/core/contracts";
import type { LoaderFunctionArgs } from "react-router";

import { appServicesContext } from "../app-services";
import { isRetiredPairPlayground, PlaygroundIdSchema } from "./playgrounds-contract";

/**
 * Read what a link shows, for comparison with the captured local project
 *
 * Also returns its name and manifest, which its embed cover describes. A playground on a retired pair has no manifest.
 */
export async function loadSharePublication({
  params,
  context,
  request,
}: LoaderFunctionArgs): Promise<
  { status: "loaded"; digest: string; name: string; manifest?: PlaygroundSnapshot["manifest"] } | { status: "failed" }
> {
  const id = PlaygroundIdSchema.safeParse(params.linkId);

  if (!id.success) {
    return { status: "failed" };
  }

  const { playgrounds } = context.get(appServicesContext);

  try {
    const published = await playgrounds.getPlaygroundSnapshot({ id: id.data, signal: request.signal });

    return {
      status: "loaded",
      digest: published.digest,
      name: published.snapshot.name,
      ...(isRetiredPairPlayground(published) ? {} : { manifest: published.snapshot.manifest }),
    };
  } catch (cause) {
    if (request.signal.aborted) {
      throw cause;
    }

    return { status: "failed" };
  }
}
