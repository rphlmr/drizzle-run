import type { RouteObject } from "react-router";
import { describe, expect, it } from "vitest";

import { appPages, appResourceRoutes, embedPages } from "../test/app-pages";
import { createAppRoutes } from "./app";

/**
 * The full path of every route a visitor's address bar can land on
 *
 * A route counts whatever it renders with (`Component`, `element`, `lazy`, or nothing for a resource route), unless an
 * index child renders at its path instead.
 */
function listAddressableRoutes(routes: readonly RouteObject[], parentPath = ""): string[] {
  return routes.flatMap((route) => {
    const path =
      route.path === undefined
        ? parentPath
        : route.path.startsWith("/")
          ? route.path
          : `${parentPath.replace(/\/$/, "")}/${route.path}`;
    const children = route.children ?? [];
    const isAddressable =
      (route.index === true || route.path !== undefined) && !children.some((child) => child.index === true);

    return [...(isAddressable ? [path || "/"] : []), ...listAddressableRoutes(children, path)];
  });
}

describe("createAppRoutes", () => {
  it("should only have routes that the route checks list", () => {
    const listed = [...Object.keys(appPages), ...Object.keys(embedPages), ...appResourceRoutes].toSorted();

    expect(listAddressableRoutes(createAppRoutes()).toSorted()).toEqual(listed);
  });
});

describe("listAddressableRoutes", () => {
  it("should count a page whatever it renders with, and a layout only without an index child", () => {
    const routes: RouteObject[] = [
      {
        Component: () => null,
        children: [
          { path: "lazy", lazy: async () => ({ Component: () => null }) },
          { path: "element", element: null },
          { path: "settings", Component: () => null, children: [{ path: "profile", Component: () => null }] },
          { path: "projects", Component: () => null, children: [{ index: true, Component: () => null }] },
        ],
      },
    ];

    expect(listAddressableRoutes(routes)).toEqual(["/lazy", "/element", "/settings", "/settings/profile", "/projects"]);
  });
});
