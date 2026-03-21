/**
 * Chico route — renders the Chico Observability Zentrale at /chico.
 */

import { createFileRoute } from "@tanstack/react-router";
import { ChicoCenter } from "../components/chico/ChicoCenter";

export const Route = createFileRoute("/chico")({
  component: ChicoCenter,
});
