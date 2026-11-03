import type { EmbedCapabilityStatus, EmbedFrameErrorCode, EmbedRunSummary } from "./protocol.js";

/** The `ready` event: the playground shows, running live or showing its recorded run where the page cannot run it. */
export type PlaygroundReadyDetail = {
  mode: "live" | "recorded";
};

/** The `capability` event: what the playground can do in this page, as the frame reports it. */
export type PlaygroundCapabilityDetail = {
  status: EmbedCapabilityStatus;
};

/**
 * The `error` event: why the playground failed to load. The frame reports an {@link EmbedFrameErrorCode}; the loader
 * reports `frame_load` when the browser reports the frame itself failed, and `timeout` when the frame is not ready in
 * 30 seconds, which is how a frame that never loads usually ends.
 */
export type PlaygroundErrorDetail = {
  code: EmbedFrameErrorCode | "frame_load" | "timeout";
};

/** The `run-settled` event: a run in the playground settled, with its outcome and bounded displays. */
export type PlaygroundRunSettledDetail = EmbedRunSummary;
