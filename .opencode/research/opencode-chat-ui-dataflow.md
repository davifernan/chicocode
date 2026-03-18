## 🔎 Research Report — OpenCode Chat UI Dataflow for T3Code

Fragestellung

- Welche Informationen zeigt OpenCode im Chat wirklich an?
- Welche dieser Informationen kommen direkt von `opencode serve`, und welche werden in der UI lokal abgeleitet?
- Welche davon landen heute schon in `t3code`, und wo gehen sie aktuell verloren?

Research-Plan

- `t3code`-OpenCode-Integration lesen, um bestehende Datenpfade und Grenzen zu verstehen.
- `../opencode` Chat/UI-Komponenten auf sichtbare Informationsflächen untersuchen.
- `../opencode` Server-, Session- und Eventfluss von REST/SSE bis UI verfolgen.
- Abgleich erstellen: OpenCode-Anzeige vs. heute in `t3code` vorhandene Daten.

Findings

1. OpenCode zeigt deutlich mehr als nur Chat-Text.
   - Evidence: Der Chat/Header/Dock zeigt Kontextmetriken, Kosten, Todo-Status und Session-Metadaten. Die Token-/Kontext-Logik sitzt in `../opencode/packages/app/src/components/session/session-context-metrics.ts:37`; die Todo-Dock-Anzeige in `../opencode/packages/app/src/pages/session/composer/session-todo-dock.tsx:37`.
   - Source: `../opencode/packages/app/src/components/session/session-context-metrics.ts:37`, `../opencode/packages/app/src/pages/session/composer/session-todo-dock.tsx:37`
   - Tradeoff: Die Anzeige ist reichhaltig, aber nicht alles ist ein einzelnes Backend-Feld; ein Teil wird im Client zusammengesetzt.

2. Die wichtigsten sichtbaren OpenCode-Infos sind: Agent, Modell, Variant, Tokens, Kontext %, Kosten, Todo-Fortschritt, Session-Status und Tool-Status.
   - Evidence: `message-v2` enthält `agent`, `providerID`, `modelID`, `variant`, `cost`, `tokens`; Session-Routen liefern `status` und `todo` separat.
   - Source: `../opencode/packages/opencode/src/session/message-v2.ts`, `../opencode/packages/opencode/src/server/routes/session.ts:69`, `../opencode/packages/opencode/src/server/routes/session.ts:155`
   - Tradeoff: Diese Daten sind verteilt ueber Message-, Session- und Neben-Endpoints/Eventtypen, nicht in einem einzigen API-Response.

3. OpenCode ist nicht nur eine dumme Terminal-Anzeige; die UI ist duenn, aber sie berechnet einige Kennzahlen lokal.
   - Evidence: `getSessionContextMetrics()` summiert `input + output + reasoning + cache.read + cache.write` und berechnet `usage = total / limit`, ausserdem summiert es Session-Kosten ueber alle Assistant-Messages.
   - Source: `../opencode/packages/app/src/components/session/session-context-metrics.ts:50`
   - Tradeoff: Tokens und Kosten pro Message kommen vom Server; Prozentwert und Session-Gesamtkosten kommen aus dem Client.

4. `opencode serve` ist die eigentliche Datenquelle; die UI lebt auf REST + SSE.
   - Evidence: Session-, Status- und Todo-Daten kommen aus `GET /session`, `GET /session/status`, `GET /session/:id/todo`; Live-Events kommen ueber `/event` aus `Bus.subscribeAll()`.
   - Source: `../opencode/packages/opencode/src/server/routes/session.ts:22`, `../opencode/packages/opencode/src/server/server.ts:507`
   - Tradeoff: Wenn du OpenCode-Features in `t3code` replizieren willst, musst du nicht die OpenCode-UI nachbauen, sondern deren Serverdaten und Eventsemantik sauber uebernehmen.

5. Todo ist in OpenCode ein echter serverseitiger Datenstrom, nicht nur eine UI-Spielerei.
   - Evidence: `Todo.update()` schreibt in die DB und publisht `todo.updated`; `GET /session/:id/todo` liefert den aktuellen Stand.
   - Source: `../opencode/packages/opencode/src/session/todo.ts:17`, `../opencode/packages/opencode/src/server/routes/session.ts:155`
   - Tradeoff: Das ist fuer `t3code` sehr attraktiv, weil Todo-Daten stabil und getrennt vom Chattext vorliegen.

6. `t3code` holt heute nur einen kleinen Teil des OpenCode-Modells rein.
   - Evidence: Bereits vorhanden sind Provider- und Agent-Proxying via `/api/opencode/providers` und `/api/opencode/agents`, plus Prompt-Senden mit `agent` und `variant`.
   - Source: `apps/server/src/wsServer.ts:509`, `apps/server/src/wsServer.ts:557`, `apps/server/src/opencode/OpenCodeClient.ts:372`, `apps/web/src/components/ChatView.tsx:1102`
   - Tradeoff: Composer-seitig kannst du Agent/Variant waehlen, aber Anzeige-seitig fehlt fast die ganze OpenCode-Telemetrie.

7. Der aktuelle OpenCode-Adapter in `t3code` ist explizit vereinfacht und droppt viele reiche Events.
   - Evidence: Der Adapter-Kommentar sagt selbst, dass nur Basis-Events gemappt werden; `mapSseToRuntimeEvents()` mappt nur wenige Session-, Message-, Text- und Tool-Events.
   - Source: `apps/server/src/provider/Layers/OpenCodeAdapter.ts:8`, `apps/server/src/provider/Layers/OpenCodeAdapter.ts:78`
   - Tradeoff: Solange diese Schicht arm bleibt, kann die `t3code`-UI gar nicht dieselbe Informationsdichte wie OpenCode zeigen.

8. Historische OpenCode-Messages verlieren in `t3code` noch mehr Information als Live-Messages.
   - Evidence: `loadOpenCodeThreadMessages()` holt zwar OpenCode-Messages, flacht sie dann aber per `extractTextFromParts()` in reinen Text um; Tokens, Cost, Agent, Provider, Model, Variant und viele Parts gehen dabei verloren.
   - Source: `apps/server/src/wsServer.ts:1106`, `apps/server/src/wsServer.ts:1151`
   - Tradeoff: Selbst wenn du spaeter die Live-UI verbesserst, bleiben gesyncte Alt-Threads unvollstaendig, solange dieser Importpfad nicht strukturerhaltend wird.

9. `t3code` kann Kosten/Usage im Domainmodell prinzipiell tragen, rendert sie im Web aber aktuell nicht.
   - Evidence: Die Contracts kennen `turn.completed.payload.usage` und `totalCostUsd`; der OpenCode-Adapter setzt beides schon auf `turn.completed`. In `apps/web/src` gibt es derzeit aber keine Nutzung von `totalCostUsd`.
   - Source: `packages/contracts/src/providerRuntime.ts:322`, `apps/server/src/provider/Layers/OpenCodeAdapter.ts:149`
   - Tradeoff: Ein Teil der Arbeit ist schon im Eventschema vorbereitet; die Web-UI nutzt das Potenzial nur noch nicht.

10. `t3code` filtert einige laufzeitnahe Aktivitaeten sogar aktiv weg.

- Evidence: `deriveWorkLogEntries()` filtert `tool.started`, `task.started` und `task.completed` heraus.
- Source: `apps/web/src/session-logic.ts:410`
- Tradeoff: Selbst korrekt eingehende OpenCode-Statussignale werden aktuell nicht voll ausgespielt.

Was OpenCode sichtbar anzeigt

- Agent-Typ / Agent-Name pro Turn
- Provider + Modellname
- Variant
- Tokenzahlen: input, output, reasoning, cache read/write, total
- Kontextlimit und Kontextnutzung in Prozent
- Session-Gesamtkosten
- Session-Titel, Parent/Child-Bezug, Share-URL
- Todo-Liste mit `pending`, `in_progress`, `completed`, `cancelled`
- Tool-Status / Tool-Titel / zum Teil Tool-Argumente oder Ergebnisse
- Session-Status (`busy`, `idle`, `retry`) sowie Permission-/Question-Docks
- MCP-/LSP-Status und geaenderte Dateien in anderen Statusflaechen

Was davon direkt vom Server kommt

- `agent`, `providerID`, `modelID`, `variant`
- `tokens.*` und `cost` pro Assistant-Message
- `session.status`
- `todo.updated` / `GET /session/:id/todo`
- Session-Metadaten wie `title`, `parentID`, `share`

Was davon lokal abgeleitet wird

- Kontext `%` aus `totalTokens / model.limit.context`
- Session-Gesamtkosten aus Summe aller `message.cost`
- Todo-Zaehler wie `3 of 5 completed`
- Aktive/naechste Todo-Vorschau

Abgleich fuer T3Code

- Bereits gut anschliessbar: Agent, Modell, Variant. Das ist schon teilweise drin.
- Kurzfristig lohnend: Kontext-Widget fuer OpenCode-Threads aus letzten bekannten `usage`-Werten plus Provider-Limits.
- Sehr wertvoll: echtes Todo-Dock fuer OpenCode-Threads via `GET /session/:id/todo` plus SSE `todo.updated`.
- Ebenfalls stark: pro Turn Meta-Zeile `Agent - Modell - Variant - Tokens - Cost`.
- Mittelgrosses Gap: Historienimport muesste strukturierter werden; reiner Textimport reicht nicht.
- Groesstes Gap: Der vereinfachte Adapter muss deutlich mehr OpenCode-SSE/Eventtypen in das T3-Runtime-Modell mappen.

Empfehlung

- Empfohlen ist ein dreistufiger Integrationsplan statt UI-Nachbau nach Augenmass.
- Why: OpenCode zeigt seine Informationen groesstenteils aus serverseitig strukturierten Daten; `t3code` sollte deshalb zuerst den Datenpfad angleichen und erst danach die UI-Flaechen bauen.

Konkrete Reihenfolge

- Phase 1: OpenCode-Telemetrie in `t3code` erhalten statt verlieren: `agent`, `providerID`, `modelID`, `variant`, `tokens`, `cost`, `todo`, `session.status`.
- Phase 2: Historische Imports nicht mehr zu Plaintext plattdruecken, sondern strukturierte Metadaten im Thread/Turn/Activity-Modell persistieren.
- Phase 3: UI-Flaechen bauen: Kontext-/Cost-Pill, Turn-Meta-Zeile, Todo-Dock, optional spaeter MCP/LSP/Permissions.

Offene Fragen

- Ob `t3code` die OpenCode-Daten 1:1 in bestehende Contracts mappen soll oder ein OpenCode-spezifisches Projektionsmodell ergaenzt.
- Ob historische OpenCode-Threads komplett neu projiziert werden sollen, damit alte Sessions dieselben Metadaten wie Live-Sessions zeigen koennen.
