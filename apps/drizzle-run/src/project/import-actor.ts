import { useSelector } from "@xstate/react";
import { createContext, createElement, useContext, type ReactElement, type ReactNode } from "react";
import type { ActorRefFrom, SnapshotFrom } from "xstate";

import type { projectImportMachine } from "./import-machine";

/** A started project import machine, such as the app's, which saves what it imports. */
export type ProjectImportActorRef = ActorRefFrom<typeof projectImportMachine>;

const ProjectImportContext = createContext<ProjectImportActorRef | null>(null);

/**
 * Project import actor provider
 *
 * Hands the project import machine to the New project dialog below it. The app creates and listens to the actor; the
 * dialog only picks files and dismisses failures.
 */
export function ProjectImportActorProvider({
  actor,
  children,
}: {
  actor: ProjectImportActorRef;
  children?: ReactNode;
}): ReactElement {
  return createElement(ProjectImportContext.Provider, { value: actor }, children);
}

/** The closest project import machine, to send it `PICK` or `DISMISS`. Throws outside `ProjectImportActorProvider`. */
export function useProjectImportActorRef(): ProjectImportActorRef {
  const actor = useContext(ProjectImportContext);

  if (actor === null) {
    throw new Error("Render project import controls inside ProjectImportActorProvider.");
  }

  return actor;
}

/** Select from the closest project import machine. Throws outside `ProjectImportActorProvider`. */
export function useProjectImportSelector<Selection>(
  selector: (snapshot: SnapshotFrom<typeof projectImportMachine>) => Selection,
  compare?: (left: Selection, right: Selection) => boolean,
): Selection {
  return useSelector(useProjectImportActorRef(), selector, compare);
}
