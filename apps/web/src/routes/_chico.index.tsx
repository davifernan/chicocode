/**
 * Chico index route — renders ChicoCenter as the full main content.
 */

import { createFileRoute } from "@tanstack/react-router";
import { ChicoCenter } from "../components/chico/ChicoCenter";

function ChicoIndexRouteView() {
  return <ChicoCenter />;
}

export const Route = createFileRoute("/_chico/")({
  component: ChicoIndexRouteView,
});
