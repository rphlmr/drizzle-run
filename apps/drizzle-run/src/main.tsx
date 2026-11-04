import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";

import { initializeAnalytics } from "./analytics";
import { createAppRouter } from "./app";
import { AppServicesProvider, type AppServices } from "./app-services";
import { createAuthService } from "./auth/service";
import { createCloudService } from "./cloud/service";
import { createCommunityService } from "./community/service";
import { createDocsService } from "./connect/docs-service";
import "./design/fonts";
import { followSystemTheme } from "./design/theme";
import { createRecordedRunsService } from "./embed/recorded-runs-service";
import { createMySharesService } from "./my-shares/service";
import { createPlaygroundsService } from "./share/playgrounds-service";
import { LocalProjectStorage } from "./store/storage";

import "./styles.css";
const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing application root");
}

const serviceDependencies = { fetch: window.fetch.bind(window), origin: window.location.origin };
const localStore = new LocalProjectStorage();
const services: AppServices = {
  auth: createAuthService(serviceDependencies),
  cloud: createCloudService(serviceDependencies),
  community: createCommunityService(serviceDependencies),
  myShares: createMySharesService(serviceDependencies),
  playgrounds: createPlaygroundsService(serviceDependencies),
  recordedRuns: createRecordedRunsService(serviceDependencies),
  fetchDocs: createDocsService(serviceDependencies),
  settings: localStore,
  localShares: localStore,
  cloudProjects: localStore,
};

const router = createAppRouter(services);

initializeAnalytics({ production: import.meta.env.PROD, origin: window.location.origin });
followSystemTheme();
createRoot(root).render(
  <AppServicesProvider services={services}>
    <RouterProvider router={router} />
  </AppServicesProvider>,
);
