## 🔎 Research Report — Electron Dev-Workflow in T3 Code

## Executive summary

- Die Electron-App existiert in diesem Repo bereits fertig unter `apps/desktop`.
- Fuer die taegliche Entwicklung im Desktop-Client ist der vorgesehene Root-Befehl `bun run dev:desktop`.
- Fuer einen gebauten Desktop-Run ist der vorgesehene Root-Befehl `bun run build:desktop` und danach `bun run start:desktop`.
- Die Architektur ist: Electron Main Process startet das React-Frontend im `BrowserWindow` und spawned den Server als Child-Prozess.
- Wichtige Einschraenkung: Im aktuellen Dev-Flow haben `apps/web` und `apps/desktop` Hot-Reload, `apps/server` aber nicht. Server-Aenderungen brauchen derzeit einen Rebuild und Electron-Neustart.

## Fragestellung

- Wie kann in diesem Projekt eine Electron-App gebaut werden?
- Wie startet man die Electron-App im Dev-Modus, damit statt Browser direkt die Desktop-App fuer die Entwicklung genutzt wird?

## Lokale Repo-Findings

### Relevante Dateien

- `package.json`
- `apps/desktop/package.json`
- `apps/desktop/src/main.ts`
- `apps/desktop/src/preload.ts`
- `apps/desktop/scripts/dev-electron.mjs`
- `apps/desktop/turbo.jsonc`
- `apps/web/vite.config.ts`
- `apps/web/src/wsTransport.ts`
- `apps/server/package.json`
- `scripts/dev-runner.ts`

### Vorhandene Befehle

- Root `dev:desktop`: `node scripts/dev-runner.ts dev:desktop`
- Root `build:desktop`: `turbo run build --filter=@t3tools/desktop --filter=t3`
- Root `start:desktop`: `turbo run start --filter=@t3tools/desktop`
- Desktop lokal: `apps/desktop/package.json` hat `dev`, `dev:bundle`, `dev:electron`, `build`, `start`

### Wie der Dev-Flow wirklich laeuft

1. `bun run dev:desktop` startet den zentralen Dev-Runner aus `scripts/dev-runner.ts`.
2. Der Dev-Runner setzt die Ports und URLs fuer Web und WS, u.a. `T3CODE_PORT`, `PORT`, `ELECTRON_RENDERER_PORT`, `VITE_WS_URL`, `VITE_DEV_SERVER_URL`.
3. Turbo startet parallel `@t3tools/web#dev` und `@t3tools/desktop#dev`.
4. `@t3tools/web#dev` startet den Vite-Dev-Server.
5. `@t3tools/desktop#dev` startet parallel:
   - `tsdown --watch` fuer `main.ts` und `preload.ts`
   - `scripts/dev-electron.mjs`, das auf den Web-Port und die gebauten Electron-Dateien wartet und dann Electron startet
6. Der Electron Main Process reserviert einen freien Backend-Port, generiert ein Token und spawned den Server.
7. Der Renderer verbindet sich im Desktop-Fall ueber `window.desktopBridge.getWsUrl()` zum lokalen WebSocket-Server.

## Technische Evidenz aus dem Repo

- Root-Script `dev:desktop` ist in `package.json:29` definiert.
- Root-Script `build:desktop` ist in `package.json:35` definiert.
- Root-Script `start:desktop` ist in `package.json:31` definiert.
- Desktop-Dev-Script `bun run --parallel dev:bundle dev:electron` steht in `apps/desktop/package.json:7`.
- Der Dev-Runner setzt `VITE_DEV_SERVER_URL` und `VITE_WS_URL` in `scripts/dev-runner.ts:152` bis `scripts/dev-runner.ts:159`.
- Der Dev-Runner bietet explizit den Modus `dev:desktop` in `scripts/dev-runner.ts:33`.
- Electron startet den Backend-Prozess mit `ELECTRON_RUN_AS_NODE=1` in `apps/desktop/src/main.ts:955` bis `apps/desktop/src/main.ts:963`.
- Electron laedt im Dev-Modus die Vite-URL ueber `loadURL(process.env.VITE_DEV_SERVER_URL as string)` in `apps/desktop/src/main.ts:1291` bis `apps/desktop/src/main.ts:1293`.
- Electron setzt die Desktop-WS-URL vor dem Fensteroeffnen in `apps/desktop/src/main.ts:1322` bis `apps/desktop/src/main.ts:1329`.
- Die Preload-Bridge exponiert `desktopBridge.getWsUrl()` in `apps/desktop/src/preload.ts:14` bis `apps/desktop/src/preload.ts:18`.
- Der Web-Client priorisiert `window.desktopBridge?.getWsUrl()` in `apps/web/src/wsTransport.ts:62` bis `apps/web/src/wsTransport.ts:72`.
- Vite ist fuer Electron-HMR auf `localhost` explizit konfiguriert in `apps/web/vite.config.ts:48` bis `apps/web/vite.config.ts:57`.
- Desktop-Dev haengt an `t3#build`, nicht an `t3#dev`, in `apps/desktop/turbo.jsonc:9` bis `apps/desktop/turbo.jsonc:12`.

## Externe Evidenz

### Electron Process Model

Quelle: Electron Docs, Process Model

- URL: https://www.electronjs.org/docs/latest/tutorial/process-model
- Relevanz: Electron empfiehlt ein Multi-Process-Modell mit Main Process, Renderer Process und optionalen Child-/Utility-Processes fuer isolierte oder crash-anfaellige Arbeit.
- Einordnung fuer dieses Repo: Die bestehende Trennung passt gut dazu, weil der Backend-Prozess nicht direkt im Renderer oder als UI-Logik laeuft.

### Electron Context Isolation

Quelle: Electron Docs, Context Isolation

- URL: https://www.electronjs.org/docs/latest/tutorial/context-isolation
- Relevanz: Empfohlener Weg ist `contextIsolation` + `contextBridge` statt direktem Node-Zugriff im Renderer.
- Einordnung fuer dieses Repo: Genau dieses Muster wird bereits verwendet (`contextIsolation: true`, `nodeIntegration: false`, Preload-Bridge ueber `desktopBridge`).

## Optionen

### Option A - Bestehenden Electron-Workflow benutzen

- Dev: `bun run dev:desktop`
- Build: `bun run build:desktop`
- Start des gebauten Clients: `bun run start:desktop`
- Vorteil: Bereits vorhanden, repo-konform, geringstes Risiko, nutzt bestehende Port-/Env-Orchestrierung.
- Nachteil: Server-Source hat im Desktop-Dev aktuell keinen echten Watch/HMR-Loop.

### Option B - Electron manuell aus `apps/desktop` starten

- Dev lokal im Paket: `bun run dev`
- Vorteil: Gut fuer isolierte Desktop-Arbeit.
- Nachteil: Schlechter als Root-Workflow, weil die Root-Orchestrierung bewusst Ports/Env konsistent setzt und Monorepo-Dependencies beruecksichtigt.

### Option C - Desktop-Dev um Server-Watch erweitern

- Ziel: `apps/server` im Desktop-Dev ebenfalls automatisch rebuilden oder im Watch-Modus starten.
- Vorteil: Vollwertiger Desktop-First-Dev-Loop.
- Nachteil: Zusaetzliche Komplexitaet bei Restart-Reihenfolge, Child-Process-Lifecycle und moeglichen Port-/Race-Conditions.

## Empfehlung

- Kurzfristig ganz klar Option A nutzen: `bun run dev:desktop`.
- Fuer Builds: `bun run build:desktop` und danach `bun run start:desktop`.
- Diese Repo-Implementierung ist bereits der richtige Einstiegspunkt; ihr muesst keine neue Electron-Integration bauen.

### Warum diese Empfehlung

- Sie folgt der vorhandenen Monorepo-Architektur statt sie zu umgehen.
- Sie nutzt bereits den zentralen Dev-Runner fuer deterministische Ports und Env-Wiring.
- Sie nutzt die vorhandene sichere Electron-Struktur mit Preload-Bridge und isoliertem Renderer.
- Sie vermeidet, dass der Browser separat als primaere Dev-Oberflaeche gebraucht wird.

## Wichtigste Einschraenkung

- `apps/server` wird im Desktop-Dev aktuell nicht als Watch-Task gefahren.
- `apps/desktop/turbo.jsonc` zeigt fuer `dev` nur `dependsOn: ["t3#build"]`.
- `apps/desktop/scripts/dev-electron.mjs` wartet auf `../server/dist/index.mjs`, also auf ein gebautes Server-Artefakt.
- Praktische Folge: Frontend- und Desktop-Main/Preload-Aenderungen reloaden gut, Backend-Aenderungen brauchen Rebuild plus Electron-Neustart.

## Konkrete Start-/Build-Anleitung

### Dev-Modus

```bash
bun run dev:desktop
```

Erwartetes Verhalten:

- Vite startet fuer `apps/web`
- Electron bundle watch startet fuer `apps/desktop`
- Electron-Fenster startet und laedt den Vite-Dev-Server
- Der lokale Backend-Server wird vom Electron Main Process als Child-Prozess gestartet

### Gebaute Desktop-App

```bash
bun run build:desktop
bun run start:desktop
```

## Empfehlung fuer den naechsten Schritt

- Wenn das Ziel nur ist, nicht mehr im Browser entwickeln zu muessen: nichts umbauen, einfach `bun run dev:desktop` als Standard-Workflow benutzen.
- Wenn ihr viel an `apps/server` arbeitet: Als Folgeprojekt einen Server-Watch-Flow fuer Desktop-Dev ergaenzen.

## Offene Fragen

- Soll `dev:desktop` kuenftig auch `apps/server` in Watch/Build-Watch mitziehen?
- Soll der Desktop-Dev-Flow bei Server-Aenderungen automatisch Electron restarten oder nur den Backend-Child-Prozess?
