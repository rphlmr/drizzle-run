import * as z from "zod/mini";

/** How a project page was reached: a new project, a Duplicate, or a Fork, each with its original's address. */
export const ProjectArrivalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("created") }),
  z.object({ kind: z.literal("duplicated"), originalHref: z.string() }),
  z.object({ kind: z.literal("forked"), originalHref: z.string() }),
]);

export type ProjectArrival = z.output<typeof ProjectArrivalSchema>;

const ArrivalStateSchema = z.object({ arrival: ProjectArrivalSchema });

/** The history state that tells the project page how it was reached. */
export function toArrivalState(arrival: ProjectArrival): z.output<typeof ArrivalStateSchema> {
  return { arrival };
}

/**
 * Read how the project page was reached
 *
 * The navigation that opened it carries the arrival in its history state. A reload, a typed address or a link has
 * none, and anything else in the state reads as none too.
 */
export function readProjectArrival(state: unknown): ProjectArrival | null {
  const parsed = ArrivalStateSchema.safeParse(state);

  return parsed.success ? parsed.data.arrival : null;
}

/** Where this browser keeps whether the intro "Your project lives in this browser" was shown. */
export const PROJECT_INTRO_SETTING = "project-intro";

/** The intro was never shown, shown and closed (it shows again for a new project), or muted for good. */
export const ProjectIntroStateSchema = z.enum(["unseen", "seen", "muted"]);

export type ProjectIntroState = z.output<typeof ProjectIntroStateSchema>;

/** The stored intro state; nothing stored, or anything unreadable, reads as never shown. */
export function readProjectIntroState(value: unknown): ProjectIntroState {
  const parsed = ProjectIntroStateSchema.safeParse(value);

  return parsed.success ? parsed.data : "unseen";
}

/** What a project shows as it opens: the intro, a toast with the way back to the original, or nothing. */
export type ArrivalNotice = "intro" | "toast" | "none";

/**
 * Get the notice a project opens with
 *
 * A new project opens on the intro until it is muted. A Duplicate opens on its toast. The first Fork ever opens on the
 * intro instead of the toast. Later Forks open on the toast.
 */
export function getArrivalNotice(arrival: ProjectArrival, intro: ProjectIntroState): ArrivalNotice {
  switch (arrival.kind) {
    case "created":
      return intro === "muted" ? "none" : "intro";
    case "forked":
      return intro === "unseen" ? "intro" : "toast";
    case "duplicated":
      return "toast";
  }
}
