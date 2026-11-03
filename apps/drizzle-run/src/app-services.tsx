import { createContext, useContext, type ReactNode } from "react";
import { createContext as createRouterContext } from "react-router";

import type { AuthService } from "./auth/contract";
import type { CloudService } from "./cloud/contract";
import type { CommunityService } from "./community/contract";
import type { FetchText } from "./connect/guide-tools";
import type { RecordedRunsService } from "./embed/recorded-runs-contract";
import type { MySharesService } from "./my-shares/contract";
import type { PlaygroundsService } from "./share/playgrounds-contract";
import type { ConnectSettingStore, LocalProjectStorage, ProjectPreferenceStorage } from "./store/storage";

/** The app's I/O services, built once at the entry and lent to the views and machines that need them. */
export interface AppServices {
  auth: AuthService;
  cloud: CloudService;
  community: CommunityService;
  myShares: MySharesService;
  playgrounds: PlaygroundsService;
  recordedRuns: RecordedRunsService;
  /** This browser's saved share links, which tell My projects and My shares which project holds which link. */
  localShares: Pick<LocalProjectStorage, "listShareLinks">;
  /** This browser's Cloud projects, for a sign-out on a page without the workspace. */
  cloudProjects: Pick<LocalProjectStorage, "loadCloudSync" | "readProject" | "removeCloudProjects">;
  /** Reads the public docs pages `read_docs` asks for. */
  fetchDocs: FetchText;
  /** This browser's settings, such as dismissed notices, and the file each project last showed. */
  settings: ConnectSettingStore & Pick<ProjectPreferenceStorage, "preference">;
}

const AppServicesContext = createContext<AppServices | null>(null);

/** The app's services in the router context, for loaders and actions. */
export const appServicesContext = createRouterContext<AppServices>();

/** Lend the app's services to every page under it. */
export function AppServicesProvider({ services, children }: { services: AppServices; children: ReactNode }) {
  return <AppServicesContext.Provider value={services}>{children}</AppServicesContext.Provider>;
}

/**
 * Read the app's services
 *
 * Throws outside `AppServicesProvider`, which `main.tsx` puts around the whole app.
 */
export function useAppServices(): AppServices {
  const services = useContext(AppServicesContext);

  if (services === null) {
    throw new Error("useAppServices needs an AppServicesProvider above it. Wrap the app in <AppServicesProvider>.");
  }

  return services;
}
