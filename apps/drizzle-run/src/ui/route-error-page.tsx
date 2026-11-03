import { isRouteErrorResponse, useRouteError } from "react-router";

import { Button } from "../components/ui/button";
import { getErrorText } from "../lib/error-text";
import { AppShell } from "./app-shell";
import { EmptyState } from "./empty-state";

function describeRouteError(error: unknown): string {
  if (isRouteErrorResponse(error)) {
    return `${error.status} ${error.statusText}`;
  }

  return getErrorText(error);
}

/**
 * The page a route shows instead of crashing when its loader, action or render throws
 *
 * Expected failures stay on their page as results; this one catches the rest, with a way to reload.
 */
export function RouteErrorPage() {
  const error = useRouteError();

  return (
    <AppShell>
      <EmptyState>
        <h1>Something went wrong</h1>
        <p>Drizzle Run hit an error it did not expect: {describeRouteError(error)}</p>
        <Button variant="outline" onClick={() => window.location.reload()}>
          Reload the page
        </Button>
      </EmptyState>
    </AppShell>
  );
}
