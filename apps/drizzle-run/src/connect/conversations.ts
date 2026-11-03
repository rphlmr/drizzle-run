/**
 * Conversation ids: one chat per project, kept in this browser.
 *
 * - `p-<projectId>`: a workspace project. A side-by-side project is one project, so both of
 *   its sides share one chat.
 * - `g-<guideId>`: a guided example. Its project is a fresh temporary copy each visit, so the
 *   chat follows the guide.
 * - `s-<linkId>`: a shared link or Community share. It reads only.
 * - `g-<guideId>-<projectId>`: a guided project (a first project walked by its guide), apart
 *   from the same project's plain chat once the guide closes.
 *
 * The protocol takes `[A-Za-z0-9_-]{1,64}`: other characters become `-`, and a longer id keeps
 * its first 56 characters plus a hash of the whole, so two long ids stay apart.
 */

const MAX_LENGTH = 64;

const HEAD_LENGTH = 56;

/** FNV-1a, 32-bit, in base 36: short, stable, and enough to tell two cut ids apart. */
function hash(text: string): string {
  let value = 0x811c9dc5;

  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }

  return value.toString(36);
}

function toConversationId(parts: readonly string[]): string {
  const id = parts.map((part) => part.replace(/[^A-Za-z0-9_-]/g, "-")).join("-");

  return id.length <= MAX_LENGTH ? id : `${id.slice(0, HEAD_LENGTH)}-${hash(id)}`;
}

/** The chat id of a project. */
export function getProjectConversation(projectId: string) {
  return toConversationId(["p", projectId]);
}

/** The chat id of a guided example, or of a guide on a saved project. */
export function getGuideConversation(guideId: string, projectId?: string) {
  return toConversationId(projectId === undefined ? ["g", guideId] : ["g", guideId, projectId]);
}

/** The chat id of a shared link. */
export function getSharedConversation(linkId: string) {
  return toConversationId(["s", linkId]);
}
