/**
 * Chico route layout — minimal shell without the chat thread sidebar.
 * ChicoCenter manages its own full-screen layout.
 */

import { Outlet, createFileRoute } from "@tanstack/react-router";

function ChicoRouteLayout() {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <Outlet />
    </div>
  );
}

export const Route = createFileRoute("/_chico")({
  component: ChicoRouteLayout,
});
