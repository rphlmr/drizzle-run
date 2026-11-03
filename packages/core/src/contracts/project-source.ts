import * as z from "zod/mini";

/** The id of one version of an official example or guide: a lowercase UUID, new for each version. */
export const OfficialVersionIdSchema = z
  .string()
  .check(z.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/));

/**
 * What a project can be forked from
 *
 * `guide` for a guided example or a first-run guide, `example` for an example without a guide.
 */
export const PROJECT_SOURCE_KINDS = ["example", "guide"] as const;

/**
 * The official version a project was forked from
 *
 * The id names the exact version it copied, so the project keeps that version's docs after a newer version replaces
 * it or it is deleted. Unknown fields are dropped.
 */
export const ProjectSourceSchema = z.object({
  kind: z.enum(PROJECT_SOURCE_KINDS),
  id: OfficialVersionIdSchema,
});

/** The official version a project was forked from. */
export type ProjectSource = z.output<typeof ProjectSourceSchema>;
