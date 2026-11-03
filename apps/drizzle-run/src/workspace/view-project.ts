/**
 * Resolve the project a workspace view keeps after a render
 *
 * `rendered` is the project the caller passed. When it is one the view saved (`isOwnSave`), it is older than or equal
 * to the view's `current` copy, and replaces it only when no edit was typed since. Any other project, such as another
 * tab's copy the workspace took over this tab's edits, replaces it even at a lower revision.
 */
export function resolveViewProject<Project extends { id: string; revision: number }>({
  rendered,
  current,
  isOwnSave,
}: {
  rendered: Project;
  current: Project;
  isOwnSave: boolean;
}): Project {
  if (!isOwnSave || rendered.id !== current.id || rendered.revision >= current.revision) {
    return rendered;
  }

  return current;
}
