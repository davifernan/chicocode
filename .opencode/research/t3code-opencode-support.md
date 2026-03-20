# Research Report - T3 Code / OpenCode Support

## Executive summary

- `t3code` ist ein sehr frisches, MIT-lizenziertes, Codex-first Monorepo mit sauberem Provider-Adapter-Seam, aber aktuell ohne echten OpenCode-Support.
- Es gibt bereits UI-Spuren fuer OpenCode (`OpenCodeIcon`, Coming-soon-Eintrag), aber die Contracts und Server-Layer sind derzeit effektiv auf `codex` festgelegt.
- `../chico` ist eine starke Referenz fuer OpenCode-Integration: HTTP REST + SSE, Session-Management, Healthchecks, Event-Streaming, Kosten-/Token-Tracking.
- Chat-Import aus OpenCode ist realistisch, weil OpenCode offiziell `export`/`import` von Session-JSON und Share-URLs unterstuetzt.
- "Alle Chats aller CLI-Tools fuer ein Projekt" ist strategisch attraktiv, aber ohne neutrales kanonisches Transcript-Modell wird das schnell unordentlich. Der bessere Start ist: erst OpenCode live anbinden, dann OpenCode-Import, dann ein neutrales Import-/Aggregation-Layer entwerfen.

## Options considered

### Option A - Nur nativer OpenCode-Provider

- Addiere OpenCode als zweiten Provider neben Codex.
- Nutze `ProviderAdapterShape` in `apps/server/src/provider/Services/ProviderAdapter.ts`.
- Uebernehme Chico-Muster fuer REST + SSE + Session-Health.

### Option B - OpenCode-Import ohne Live-Provider

- Importiere OpenCode-Sessions in `t3code`-Threads/Messages.
- Nutze OpenCode-JSON-Export oder Share-URLs als Quelle.
- Gut fuer einheitliche History, aber man kann danach nicht automatisch in derselben Session live mit OpenCode fortsetzen.

### Option C - Live-Provider + Import

- OpenCode als nativen Provider integrieren.
- Zusaetzlich einen Importpfad schaffen, der exportierte OpenCode-Sessions in `t3code`-Threads materialisiert.
- Beste Produktstory fuer "importieren und dann mit OpenCode weitermachen", sofern die importierte Thread-Metadatenstruktur den OpenCode-`session_id` erhalten kann.

### Option D - Universelle Multi-CLI-Projekthistorie

- Entwerfe ein neutrales Transcript-/Activity-Modell fuer Codex, OpenCode, Claude Code, Cursor, evtl. Aider.
- Importiere oder indexiere Tool-spezifische Sessions projektweit.
- Hoechster Nutzerwert, aber auch groesster Architektur- und Mapping-Aufwand.

## Evidence and source notes

### T3 Code - aktueller Stand

- Lizenz: MIT in `LICENSE:1`.
- Positionierung: "minimal web GUI for coding agents", aktuell Codex-first in `README.md:3`.
- Monorepo-Struktur in `package.json:4` mit `apps/*`, `packages/*`, `scripts`.
- Provider-Kern aktuell single-provider: `ProviderKind = Schema.Literal("codex")` in `packages/contracts/src/orchestration.ts:30`.
- Provider-Startoptionen ebenfalls codex-only in `packages/contracts/src/orchestration.ts:46` und `packages/contracts/src/provider.ts:50`.
- Multi-provider-Seam existiert bereits ueber `ProviderAdapterShape` in `apps/server/src/provider/Services/ProviderAdapter.ts:45` und Registry in `apps/server/src/provider/Services/ProviderAdapterRegistry.ts:20`.
- Runtime-Wiring ist aktuell Codex-only: `makeCodexAdapterLive` in `apps/server/src/serverLayers.ts:22` und `apps/server/src/serverLayers.ts:58`.
- OpenCode ist bisher nur UI/Produkt-Teaser: `apps/web/src/components/ChatView.tsx:5656` und Icon in `apps/web/src/components/Icons.tsx`.
- Provider-Picker zeigt weiterhin nur `codex` als verfuegbar; `claudeCode` und `cursor` sind disabled in `apps/web/src/session-logic.ts:21`.

### T3 Code - Historischer Kontext

- Git-Historie zeigt fruehere echte Multi-Provider-Arbeit: z. B. `Add Claude provider support across backend, contracts, and UI`, `Wire Claude adapter into registry and server provider layer`, `Add Cursor provider support across backend, contracts, and UI`.
- Spaeterer Rueckbau ist ebenfalls klar sichtbar: `Remove Claude adapter from stack base`, `Remove Cursor adapter from stack base`, `move cursor provider surface out of core`, `move Claude provider surface to sibling stack`.
- Fazit: Multi-Provider war real, wurde aber aus dem Core wieder herausgezogen. Das ist eher ein Fokus-/Komplexitaetsentscheid als ein fehlender Architekturversuch.

### Chico - uebertragbare OpenCode-Muster

- OpenCode-Client mit Basic Auth und `x-opencode-directory` in `../chico/src/opencode/client.rs:43`.
- Session-Erzeugung via `POST /session` und Fire-and-forget-Prompts via `POST /session/:id/prompt_async` in `../chico/src/opencode/client.rs:131` und `../chico/src/opencode/client.rs:181`.
- Dokumentierte OpenCode-API in `../chico/documentation/opencode/api-reference.md:21`.
- Globale SSE-Events unter `/global/event`, Session-/Message-/Permission-Endpunkte in `../chico/documentation/opencode/api-reference.md:27`, `../chico/documentation/opencode/api-reference.md:54`, `../chico/documentation/opencode/api-reference.md:110`, `../chico/documentation/opencode/api-reference.md:193`.
- Chico behandelt OpenCode als ServerProvider mit klarer Boundary; laut Subagent besonders relevant: Session-Manager, SSE-Reconnect, Activity-Tracking, Cost-/Token-Erfassung.

### OpenCode - Import/Export und Session-Portabilitaet

- Offizielle CLI-Doku nennt `opencode export [sessionID]` und `opencode import <file>` in `https://opencode.ai/docs/cli` (Stand: Last updated Mar 10, 2026).
- Import unterstuetzt lokale JSON-Dateien und Share-URLs laut `https://opencode.ai/docs/cli`.
- Share-Funktion synchronisiert komplette Konversationshistorie, Nachrichten, Antworten und Session-Metadaten laut `https://opencode.ai/docs/share`.
- Der offizielle Import-Code akzeptiert JSON oder Share-URL und materialisiert Session, Messages und Parts in die lokale DB: `https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/cli/cmd/import.ts`.
- Der offizielle Export-Code serialisiert `info` + `messages[].parts[]`: `https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/cli/cmd/export.ts`.
- DB-Pfad kommt aus `Global.Path.data` plus `opencode.db`: `https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/global/index.ts` und `https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/storage/db.ts`.

### Oekosystem-Signale

- Es gibt reale Nachfrage nach Interop, aber keinen klaren Standard fuer tool-uebergreifende Chat-Transkripte.
- OpenCode-Issues zeigen Wunsch nach Import aus Claude Code / anderen Tools, z. B. `anomalyco/opencode#10305`, `anomalyco/opencode#6207`.
- Auch vollstaendige Transcript-Retention ist noch aktiv diskutiert: `anomalyco/opencode#16765`.
- Claude-Kompatibilitaet in OpenCode ist vor allem fuer Regeln/Skills/Hooks ein Thema, nicht fuer universelle Transcript-Normalisierung: `anomalyco/opencode#12472`.

## Tradeoffs

### Native OpenCode-Integration

- Vorteil: sauberste UX fuer "in T3 Code mit OpenCode arbeiten".
- Vorteil: nutzt vorhandene Provider-Architektur statt Sonderweg.
- Risiko: `t3code` ist im Kern noch codex-shaped; Contracts, Healthchecks, Modellkataloge und Defaults muessen enthaertet werden.

### Import von OpenCode-Chats

- Vorteil: schnellster Weg, historische OpenCode-Sessions sichtbar zu machen.
- Vorteil: offizielle OpenCode-Formate sind dokumentiert und stabil genug, um gegen JSON/Share-Importer zu entwickeln.
- Risiko: Import allein loest nicht automatisch "nahtlos weiter in derselben Live-Session arbeiten", ausser man speichert/provider-mappt die originale `session_id` bewusst.

### Alle Chats aller Tools projektweit anzeigen

- Vorteil: starkes Differenzierungsmerkmal fuer `t3code`.
- Vorteil: passt gut zum event-sourced/read-model Setup auf Server-Seite.
- Risiko: ohne kanonisches Modell fuer Messages, tool calls, approvals, plans, checkpoints und session lineage wird das inkonsistent.
- Risiko: einige Tools bieten Import/Export offiziell, andere nur implizit oder gar nicht.

## Recommendation

- Empfohlen ist **Option C als Produktpfad, technisch in 3 Phasen**.

### Phase 1 - OpenCode als nativen Provider ermoeglichen

- `ProviderKind`, Model-Kataloge und Startoptionen von codex-only auf multi-provider umstellen.
- `OpenCodeAdapter` analog zur existierenden Adapter-Registry einfuehren.
- Chico-Muster fuer REST, Basic Auth, SSE-Reconnect, Healthcheck und Session-Abbruch uebernehmen.
- Wichtig: `provider/tool` als **thread-level** Attribut persistieren, nicht nur als fluechtige Session-Info.

### Phase 2 - OpenCode-Import bauen

- Neuer Ingestion-Pfad in `t3code`, der OpenCode-Export-JSON oder Share-URL in interne Threads/Messages materialisiert.
- Originale OpenCode-Metadaten mitspeichern: `session_id`, share slug/url, provider model, timestamps, tool parts.
- Danach kann `t3code` entweder:
  - imported thread read-only anzeigen, oder
  - bei vorhandenem OpenCode-Provider wieder an dieselbe Session andocken/fortsetzen.

### Phase 3 - neutrales Transcript-Layer fuer Multi-CLI-History

- Erst nach erfolgreichem OpenCode-Pfad ein kanonisches Modell fuer externe Transcript-Importe definieren.
- Start mit `codex` + `opencode`; spaeter `claudeCode`, `cursor`, andere.
- Das ist das richtige Fundament fuer "alle Chats aller Tools fuer ein Projekt".

## Open questions

- Soll `t3code` bei Importen nur Snapshots materialisieren, oder auch originale externe Session-IDs als resume-faehige Foreign Keys fuehren?
- Soll projektweite Fremd-Chathistorie read-only sein, oder wirklich "continue with original tool" unterstuetzen?
- Wie tief sollen OpenCode-Toolparts gemappt werden: nur Text + einfache Activity, oder vollstaendig als rich timeline inkl. Tool-Aufrufen, Kosten, Permissions, Fragen?
- Ist das Produktziel primaer Live-Steuerung mehrerer Tools, oder eher ein universeller Projekt-Chat-Hub?
