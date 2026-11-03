import type { ReactNode } from "react";

/** The full-height page column under every app route. */
export function AppShell({ children }: { children: ReactNode }) {
  return <div className="flex h-dvh flex-col bg-bg">{children}</div>;
}
