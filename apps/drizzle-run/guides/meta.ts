/**
 * What Drizzle Run reads from a guide's `meta`; core and the machines ignore it.
 *
 * The guide's own `id` is the id of this version: a new version of a guide gets a new id and keeps the slug.
 */
export type DrizzleRunGuideMeta = {
  /** Permanent and URL-safe: the slug of the example the guide walks, or its own for a guide without one. */
  slug: string;
  /** `draft` shows in development builds only; `deleted` keeps the version for the projects forked from it. */
  status: "published" | "draft" | "deleted";
  /** The id of the example version the guide walks; absent for a guide without an example, such as the first run. */
  example?: string;
  /** Words of the title drawn with the lime highlight. */
  mark?: string;
};

/** What Drizzle Run reads from a step's `meta`, as rich text. */
export type DrizzleRunStepMeta = {
  /** One line about the step, shown in the guide rail before it starts. */
  summary: string;
  /** What the step's run showed, shown once it ran and on the finished guide. */
  changed?: string;
  /** What the step's edit takes out, named in the code once it ran: "step 2 removed the throw". */
  removed?: string;
  /** Chips on lines before the step runs, each on the first line of `file` holding `match`. */
  lineNotes?: { file: string; match: string; text: string }[];
};
