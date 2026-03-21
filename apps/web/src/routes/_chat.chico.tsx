/**
 * Chico route — renders the Chico Observability Zentrale inside the shared
 * T3Code chat layout so the sidebar/header remain visible.
 */

import { createFileRoute } from "@tanstack/react-router";
import { ChicoCenter } from "../components/chico/ChicoCenter";

export const Route = createFileRoute("/_chat/chico")({
  component: ChicoCenter,
});
