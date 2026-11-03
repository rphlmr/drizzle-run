import type { PendingEdit } from "@drizzle-run/runtime/machines";
import * as z from "zod/mini";

import { IntegerSchema } from "../lib/records";

/** Agent edits waiting for Keep or Undo, kept so a reload still asks for them. */
export const PENDING_EDITS_SETTING = "connect.pending-edits";

const FileChangeSchema = z.object({
  path: z.string(),
  before: z.optional(z.string()),
  after: z.string(),
  added: IntegerSchema,
  removed: IntegerSchema,
});

const PendingEditSchema = z.object({
  id: z.string(),
  toolCallId: z.string(),
  createdAt: z.number(),
  projectId: z.string(),
  projectName: z.string(),
  side: z.optional(z.union([z.literal(0), z.literal(1)])),
  where: z.optional(z.string()),
  summary: z.optional(z.string()),
  files: z.array(FileChangeSchema),
}) satisfies z.ZodMiniType<PendingEdit>;

/** The stored pending edits, or none when the setting is missing or does not read. */
export function readPendingEdits(value: unknown): PendingEdit[] {
  const stored = z.array(PendingEditSchema).safeParse(value);

  return stored.success ? stored.data : [];
}

/**
 * Merge a tab's pending edits into the stored ones
 *
 * Keeps the stored edits of other tabs, drops the ones this tab knew and settled since (`knownIds`), and adds this
 * tab's `edits`. An edit this tab knew that the store no longer holds was settled in another tab, so it stays out.
 */
export function mergePendingEdits(
  stored: unknown,
  edits: readonly PendingEdit[],
  knownIds: readonly string[],
): PendingEdit[] {
  const storedEdits = readPendingEdits(stored);
  const storedIds = new Set(storedEdits.map((edit) => edit.id));
  const otherTabs = storedEdits.filter(
    (edit) => !knownIds.includes(edit.id) && !edits.some((item) => item.id === edit.id),
  );
  const stillPending = edits.filter((edit) => !knownIds.includes(edit.id) || storedIds.has(edit.id));

  return [...otherTabs, ...stillPending];
}
