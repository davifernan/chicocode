# Frontend Perceived Latency — Umsetzungsplan

## T3 Code / Chicocode

> Erstellt: 2026-03-19  
> Basis: Research `frontend-perceived-latency.md`  
> Status: bereit zur Umsetzung

---

## Kernthese

80–92 % der gefühlten Langsamkeit in Chicocode kommt aus dem Frontend, nicht dem Backend.  
Kein Backend-Umbau, bevor die Frontend-Hebel abgearbeitet sind.

Die drei wichtigsten Patterns — Optimistic UI, Suspense + Skeletons, Prefetching + Code Splitting —  
sind in der Codebase schon punktuell vorhanden, aber nicht systematisch und nicht an den Stellen,  
die den größten UX-Effekt haben.

**Reihenfolge nach Wirkung vs. Risiko (nicht nach Pattern-Glamour):**

1. Blank States → Skeletons
2. Timer-Isolation (nowTick)
3. Markdown-Defer
4. Zustand-Subscriptions verengen
5. Code Splitting
6. useOptimistic systematisieren
7. Intent-basiertes Prefetching

---

## Worktree-Strategie

Jede Phase hat einen eigenen Worktree und Branch.  
Kein Branch-Switching. Parallele Entwicklung möglich. Atomare PRs.

```bash
git worktree add ../t3code-perf-p1 -b feat/perf-p1-skeletons
git worktree add ../t3code-perf-p2 -b feat/perf-p2-timer-isolation
git worktree add ../t3code-perf-p3 -b feat/perf-p3-subscription-narrowing
git worktree add ../t3code-perf-p4 -b feat/perf-p4-markdown-defer
git worktree add ../t3code-perf-p5 -b feat/perf-p5-code-splitting
git worktree add ../t3code-perf-p6 -b feat/perf-p6-optimistic-ui
git worktree add ../t3code-perf-p7 -b feat/perf-p7-prefetching
```

### Abhängigkeiten zwischen Phasen

```
P1 ──► P5 (Phase 5 reused ChatViewSkeleton aus Phase 1)
P5 ──► P7 (router.preloadRoute macht erst Sinn wenn ChatView lazy ist)
P2, P3, P4, P6 sind vollständig unabhängig voneinander
```

### Empfohlene PR-Reihenfolge

```
P1 → P2 → P4 → P3 → P5 (nach P1-Merge) → P6 → P7 (nach P5-Merge)
```

**Parallelisierbar:** P1 + P2 + P4 können gleichzeitig in drei Worktrees laufen.

---

## Phase 1 — Blank States eliminieren

**Branch:** `feat/perf-p1-skeletons`  
**Worktree:** `../t3code-perf-p1`  
**UX-Impact:** sehr hoch  
**Risiko:** niedrig  
**Aufwand:** ~1.5 Tage

### Problem

Die App zeigt beim Start und beim Thread-Wechsel schlicht **nichts** statt einer erkennbaren Struktur.

- `apps/web/src/routes/__root.tsx:47` — Plain-Text "Connecting to T3 Code server..."
- `apps/web/src/routes/_chat.$threadId.tsx:211` — `return null` während Threads-Hydration

Ein leerer Screen fühlt sich deutlich langsamer an als eine sofort sichtbare Layout-Struktur,  
auch wenn die tatsächliche Ladezeit identisch ist.

---

### Task 1.1 — Neue Datei: `ChatViewSkeleton.tsx`

**Pfad:** `apps/web/src/components/ChatViewSkeleton.tsx`

Nachahmen der echten App-Struktur mit `Skeleton`-Primitiven aus `ui/skeleton.tsx`.

**Layout-Spezifikation (basierend auf ChatHeader + MessagesTimeline + Composer):**

```
Header (border-b, h-[52px] in Electron / h-12 Web):
  links:  [Skeleton h-4 w-7 rounded-md]  [Skeleton h-4 w-32]  [Skeleton h-4 w-16 rounded-full]
  rechts: [Skeleton h-7 w-7 rounded-md]  [Skeleton h-7 w-7 rounded-md]  [Skeleton h-7 w-7 rounded-md]

MessagesArea (flex-1, px-4 py-6, gap-6):
  Msg 1 — assistant (links):
    [Skeleton h-3 w-full max-w-[72%]]
    [Skeleton h-3 w-10/12 max-w-[72%]]
    [Skeleton h-3 w-8/12 max-w-[72%]]
  Msg 2 — user (rechts):
    [Skeleton h-8 w-64 ml-auto rounded-2xl rounded-br-sm]
  Msg 3 — assistant (links):
    [Skeleton h-3 w-full max-w-[72%]]
    [Skeleton h-3 w-11/12 max-w-[72%]]
    [Skeleton h-3 w-full max-w-[72%]]
    [Skeleton h-3 w-9/12 max-w-[72%]]
  Msg 4 — user (rechts):
    [Skeleton h-8 w-48 ml-auto rounded-2xl rounded-br-sm]
    [Skeleton h-8 w-32 ml-auto]

ComposerBar (border-t, px-4 py-3, gap-2):
  [Skeleton h-10 flex-1 rounded-xl]
  [Skeleton h-8 w-8 rounded-md]
  [Skeleton h-8 w-16 rounded-lg]
```

**Exportierte Varianten:**

- `<ChatViewSkeleton />` — vollständiges Layout (Header + Messages + Composer)
- `<ChatViewMessagesSkeleton />` — nur Message-Fläche (für Suspense-Fallback innerhalb gemounteter View)

**Accessibility:** `role="status"` + `aria-label="Lade Unterhaltung..."` auf dem Root-Element.

---

### Task 1.2 — Neue Datei: `AppShellSkeleton.tsx`

**Pfad:** `apps/web/src/components/AppShellSkeleton.tsx`

Für den Root-Connect-State: vollständiges Two-Panel-Layout.

**Layout-Spezifikation:**

```
Outer: flex h-screen bg-background

Left Panel (w-[280px] shrink-0, border-r border-border):
  Header (h-[52px] border-b, px-3):
    [Skeleton h-5 w-28]   [Skeleton h-7 w-7 ml-auto rounded-md]

  Content (px-2 py-2, gap-0.5):
    Project Row 1:
      [ChevronRight-Icon placeholder h-4 w-4 opacity-20]  [Skeleton h-4 w-28]
      Thread 1a:  indent ml-5  [Skeleton h-3.5 w-40]
      Thread 1b:  indent ml-5  [Skeleton h-3.5 w-32]
      Thread 1c:  indent ml-5  [Skeleton h-3.5 w-36]
    Project Row 2 (mt-3):
      [ChevronRight-Icon placeholder h-4 w-4 opacity-20]  [Skeleton h-4 w-20]
      Thread 2a:  indent ml-5  [Skeleton h-3.5 w-44]
      Thread 2b:  indent ml-5  [Skeleton h-3.5 w-28]

  Footer (border-t border-border, h-12, px-3, gap-2):
    [Skeleton h-5 w-5 rounded-full]   [Skeleton h-5 w-5 ml-auto rounded-md]

Right Panel (flex-1, min-w-0):
  → <ChatViewSkeleton />
```

---

### Task 1.3 — Root Connect State ersetzen

**Datei:** `apps/web/src/routes/__root.tsx:47-57`

**Vorher:**

```tsx
if (!readNativeApi()) {
  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted-foreground">Connecting to {APP_DISPLAY_NAME} server...</p>
      </div>
    </div>
  );
}
```

**Nachher:**

```tsx
if (!readNativeApi()) {
  return <AppShellSkeleton />;
}
```

---

### Task 1.4 — Thread-Hydration Guard ersetzen

**Datei:** `apps/web/src/routes/_chat.$threadId.tsx:200-213`

**Vorher:**

```tsx
if (!threadsHydrated || !routeThreadExists) {
  return null;
}
```

**Nachher:**

```tsx
// Echter 404 nach Hydration: kurz null, useEffect navigiert weg
if (threadsHydrated && !routeThreadExists) {
  return null;
}

// Noch nicht hydratisiert: Skeleton zeigen
if (!threadsHydrated) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <ChatViewSkeleton />
    </SidebarInset>
  );
}
```

### Acceptance Criteria Phase 1

- [ ] App zeigt beim ersten Start sofort ein Layout (kein leerer Screen)
- [ ] Thread-Wechsel zeigt Skeleton statt leerem Panel
- [ ] Skeleton-Abstände und Größen entsprechen dem echten Layout (kein Layout-Shift beim Einblenden)
- [ ] `bun fmt && bun lint && bun typecheck` grün

---

## Phase 2 — `nowTick`-Timer isolieren

**Branch:** `feat/perf-p2-timer-isolation`  
**Worktree:** `../t3code-perf-p2`  
**UX-Impact:** hoch während aktiver Sessions  
**Risiko:** sehr niedrig  
**Aufwand:** ~0.5 Tage

### Problem

`nowTick` als `useState` in `ChatView` (`apps/web/src/components/ChatView.tsx:540`) triggert via  
`setInterval` jede Sekunde einen kompletten Re-Render des 5200-Zeilen-`ChatView`-Trees,  
sobald `isWorking === true` ist (`ChatView.tsx:2627–2636`).

`nowIso` wird als Prop an `MessagesTimeline` weitergereicht (`ChatView.tsx:1096`).

---

### Task 2.1 — Neue Datei: `WorkingTimer.tsx`

**Pfad:** `apps/web/src/components/WorkingTimer.tsx`

```tsx
interface WorkingTimerProps {
  startedAt: string | null; // ISO string
  isWorking: boolean;
}

export function WorkingTimer({ startedAt, isWorking }: WorkingTimerProps) {
  const [nowTick, setNowTick] = useState(() => Date.now());

  useEffect(() => {
    if (!isWorking) return;
    setNowTick(Date.now());
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isWorking]);

  // Rendert den Elapsed-String — nur diese Komponente re-rendert jede Sekunde
  const nowIso = new Date(nowTick).toISOString();
  const elapsed = startedAt ? formatElapsed(startedAt, nowIso) : null;

  return elapsed ? <span className="text-xs text-muted-foreground">{elapsed}</span> : null;
}
```

---

### Task 2.2 — `nowTick` aus `ChatView` entfernen

**Datei:** `apps/web/src/components/ChatView.tsx`

Zu entfernen/ändern:

- `:540` — `useState(nowTick)` entfernen
- `:1096` — `const nowIso = new Date(nowTick).toISOString()` entfernen
- `:2627–2636` — `useEffect` mit `setInterval` entfernen
- Alle Prop-Weitergaben von `nowIso` an `MessagesTimeline` ersetzen

---

### Task 2.3 — `MessagesTimeline` / Working-Row anpassen

`MessagesTimeline` bekommt `nowIso` heute für den "Working"-Timestamp.  
Nach dem Refactoring: `<WorkingTimer startedAt={...} isWorking={...} />` direkt innerhalb  
der Working-Row rendern — kein `nowIso` mehr als Prop.

**Alle anderen `nowIso`-Verwendungen prüfen:** Relative Zeitstempel bei Messages brauchen  
kein 1s-Update. Dort reicht eine stabile Zeit beim Mount oder beim nächsten Store-Update.

### Acceptance Criteria Phase 2

- [ ] Kein `setInterval` mehr in `ChatView` selbst
- [ ] Elapsed Timer zeigt weiterhin korrekt die laufende Zeit an
- [ ] `ChatView` rendert während aktiver Agent-Arbeit nicht mehr im Sekundentakt komplett neu
- [ ] `bun fmt && bun lint && bun typecheck` grün

---

## Phase 3 — Zustand-Subscriptions verengen

**Branch:** `feat/perf-p3-subscription-narrowing`  
**Worktree:** `../t3code-perf-p3`  
**UX-Impact:** hoch  
**Risiko:** mittel  
**Aufwand:** ~2 Tage

### Problem

`ChatView` subscribed auf `store.threads` (gesamtes Array) — jedes Domain-Event für irgendein  
beliebiges Thread triggert einen `ChatView`-Re-Render, auch wenn der aktive Thread gar nicht  
betroffen ist (`ChatView.tsx:419`).

`Sidebar` hat einen 60s-`setInterval` direkt im Komponenten-State (`Sidebar.tsx:340`),  
der das gesamte 2000-Zeilen-Sidebar-Tree neu rendert. Zusätzlich O(n) Ableitungsschleifen  
über alle Threads bei jedem Render (`Sidebar.tsx:360–373`).

---

### Task 3.1 — `ChatView`: thread-granulare Subscription

**Datei:** `apps/web/src/components/ChatView.tsx:419–420`

**Vorher:**

```tsx
const threads = useStore((store) => store.threads);
// später: const serverThread = threads.find((t) => t.id === threadId);
```

**Nachher:**

```tsx
const serverThread = useStore((store) => store.threads.find((t) => t.id === threadId) ?? null);
```

Alle weiteren Verwendungen von `threads` im Component einzeln prüfen und mit engeren  
Selectors ersetzen oder direkt via API-Call ohne Store-Sub handhaben.

---

### Task 3.2 — `Sidebar`: `relativeTimeNow`-Tick isolieren

**Datei:** `apps/web/src/components/Sidebar.tsx:340,350–358`

Neues Component `<RelativeTimestamp time={createdAt} />`:

```tsx
export function RelativeTimestamp({ time }: { time: string }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  return <span>{formatRelativeTime(time, now)}</span>;
}
```

Direkt beim Thread-Item einsetzen — die Sidebar selbst hält keinen Timer-State mehr.

---

### Task 3.3 — `Sidebar`: O(n) Ableitungen mit `shallow` Selector stabilisieren

**Datei:** `apps/web/src/components/Sidebar.tsx:360–373`

**Option A (gewählt für Phase 3):**

```tsx
import { shallow } from "zustand/shallow";

const pendingApprovalByThreadId = useStore(
  (store) => {
    const map = new Map<ThreadId, boolean>();
    for (const t of store.threads) {
      map.set(t.id, derivePendingApprovals(t.activities).length > 0);
    }
    return map;
  },
  shallow, // Map-Vergleich: nur re-render wenn sich tatsächlich Werte ändern
);
```

### Acceptance Criteria Phase 3

- [ ] React DevTools Profiler zeigt messbar weniger Re-Renders in `ChatView` bei Domain-Events fremder Threads
- [ ] Sidebar rendert nicht mehr minütlich komplett neu
- [ ] Kein Regressionen in Thread-Navigation, Pending-Status, Rename, Drag-and-Drop
- [ ] `bun fmt && bun lint && bun typecheck` grün

---

## Phase 4 — Streaming-Markdown entlasten

**Branch:** `feat/perf-p4-markdown-defer`  
**Worktree:** `../t3code-perf-p4`  
**UX-Impact:** mittel (Streaming-Sessions)  
**Risiko:** niedrig  
**Aufwand:** ~0.5 Tage

### Problem

`ReactMarkdown` mit `remarkGfm` parsed und rendert die volle Markdown-AST synchron auf  
jedem Stream-Chunk-Update (`ChatMarkdown.tsx:302`). Während Streaming feuert das  
hunderte Male und blockiert dabei User-Interaktionen (Composer-Tippen, Scrollen)  
auf dem Main Thread.

---

### Task 4.1 — `useDeferredValue` für `text` in `ChatMarkdown`

**Datei:** `apps/web/src/components/ChatMarkdown.tsx:242–305`

**Vorher:**

```tsx
function ChatMarkdown({ text, cwd, isStreaming = false, variant = "default" }: ChatMarkdownProps) {
  // ...
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {text}
    </ReactMarkdown>
  );
}
```

**Nachher:**

```tsx
function ChatMarkdown({ text, cwd, isStreaming = false, variant = "default" }: ChatMarkdownProps) {
  const deferredText = useDeferredValue(text);
  const isStale = isStreaming && text !== deferredText;

  return (
    <div className={cn("chat-markdown ...", isStale && "opacity-90 transition-opacity")}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {deferredText}
      </ReactMarkdown>
    </div>
  );
}
```

React priorisiert damit Composer-Input und Scroll-Events über Markdown-Re-Parsing.

**Wichtig:** `markdownComponents` bleibt via `useMemo([cwd, diffThemeName, isStreaming])` stabil.

### Acceptance Criteria Phase 4

- [ ] Composer reagiert während aktivem Streaming merklich flüssiger
- [ ] Rendered Markdown ist konsistent (kein Missing-Content)
- [ ] Code-Highlighting und Shiki-Suspense verhalten sich unverändert
- [ ] `bun fmt && bun lint && bun typecheck` grün

---

## Phase 5 — Code Splitting + Bundle-Strategie

**Branch:** `feat/perf-p5-code-splitting`  
**Worktree:** `../t3code-perf-p5`  
**Abhängigkeit:** Phase 1 muss gemergt sein (Skeleton-Reuse)  
**UX-Impact:** mittel (Cold Load + Thread-Navigation)  
**Risiko:** mittel  
**Aufwand:** ~2 Tage

### Problem

`ChatView` wird statisch importiert (`_chat.$threadId.tsx:5`). Beim Öffnen des  
Chat-Pfades lädt der Browser die gesamte `ChatView`-Komponente inklusive aller  
schweren Dependencies (Lexical Editor, xterm, react-markdown) bevor irgendetwas  
gerendert werden kann.

`vite.config.ts` hat keine explizite Chunk-Strategie für schwere Libraries.

---

### Task 5.1 — Bundle-Analyse (Voraussetzung)

```bash
bun add -D rollup-plugin-visualizer
# vite.config.ts: visualizer() Plugin temporär hinzufügen
bun run build
# ./dist/stats.html analysieren
```

**Entscheidungsbaum:**

- Wenn Lexical / xterm / react-markdown im Entry-Chunk → `manualChunks` nötig
- Wenn bereits separiert → nur lazy-Loading ohne Chunk-Config nötig
- Screenshot / HTML-Report in `.opencode/research/` speichern

---

### Task 5.2 — `ChatView` lazy laden

**Datei:** `apps/web/src/routes/_chat.$threadId.tsx:5`

**Vorher:**

```tsx
import ChatView from "../components/ChatView";
```

**Nachher:**

```tsx
const ChatView = lazy(() => import("../components/ChatView"));
```

Im JSX:

```tsx
<Suspense fallback={<ChatViewSkeleton />}>
  <ChatView ... />
</Suspense>
```

`<ChatViewSkeleton />` stammt aus Phase 1 — dort bereits fertig.

**Wichtig:** `lazy()` auf Modul-Ebene deklarieren, nicht innerhalb der Routing-Component.

---

### Task 5.3 — `manualChunks` (bedingt, nach Analyse)

**Datei:** `apps/web/vite.config.ts`

Nur wenn Bundle-Analyse zeigt, dass schwere Libs im Entry-Chunk landen:

```ts
build: {
  rollupOptions: {
    output: {
      manualChunks: {
        "vendor-editor":   [/^@lexical\//],
        "vendor-terminal": ["@xterm/xterm", "@xterm/addon-fit"],
        "vendor-markdown": ["react-markdown", "remark-gfm"],
      },
    },
  },
},
```

Vite hebt diese Chunks automatisch mit `<link rel="modulepreload">` in den HTML-Output.

### Acceptance Criteria Phase 5

- [ ] Bundle-Analyse-Report in `.opencode/research/` dokumentiert
- [ ] ChatView lädt lazy — Skeleton zeigt sich beim ersten Thread-Öffnen
- [ ] Entry-Bundle-Größe messbar kleiner (Baseline vorher notiert)
- [ ] Kein Flash of Unstyled Content (Vite's CSS-Code-Splitting handled das automatisch)
- [ ] `bun fmt && bun lint && bun typecheck` grün

---

## Phase 6 — `useOptimistic` systematisieren

**Branch:** `feat/perf-p6-optimistic-ui`  
**Worktree:** `../t3code-perf-p6`  
**UX-Impact:** mittel (Mutations / Send-Flow)  
**Risiko:** niedrig  
**Aufwand:** ~1 Tag

### Problem

`optimisticUserMessages` wird als `useState<ChatMessage[]>` mit manuellen Ref-Tracking  
und einem Cleanup-`useEffect` implementiert (`ChatView.tsx:505–507`).  
Das ist fehleranfällig bei gleichzeitigen Mutations und nicht idiomatisches React 19.

---

### Task 6.1 — Migration auf `useOptimistic`

**Datei:** `apps/web/src/components/ChatView.tsx:505–507`

**Vorher:**

```tsx
const [optimisticUserMessages, setOptimisticUserMessages] = useState<ChatMessage[]>([]);
const optimisticUserMessagesRef = useRef(optimisticUserMessages);
optimisticUserMessagesRef.current = optimisticUserMessages;
```

**Nachher:**

```tsx
const [optimisticUserMessages, addOptimisticMessage] = useOptimistic(
  serverMessages,
  (current, newMessage: ChatMessage) => [...current, { ...newMessage, pending: true }],
);
```

Sender-Callback beim Submit:

```tsx
startTransition(() => {
  addOptimisticMessage(newMessage);
  // dann: server call
});
```

---

### Task 6.2 — Cleanup-Effect entfernen

**Datei:** `apps/web/src/components/ChatView.tsx:2449–2482`

Der `useEffect` der optimistische Nachrichten beim Empfang der Server-IDs manuell bereinigt  
wird durch `useOptimistic` automatisch erledigt — entfernen.

### Acceptance Criteria Phase 6

- [ ] Gesendete Nachrichten erscheinen instant in der Timeline (pending: true State)
- [ ] Pending-Nachrichten zeigen visuelles Pending-Signal (Opacity / Dot)
- [ ] Bei Fehler verschwindet die Pending-Nachricht und ein Toast erscheint
- [ ] Kein doppeltes Rendering (optimistisch + bestätigt)
- [ ] `bun fmt && bun lint && bun typecheck` grün

---

## Phase 7 — Intent-basiertes Prefetching

**Branch:** `feat/perf-p7-prefetching`  
**Worktree:** `../t3code-perf-p7`  
**Abhängigkeit:** Phase 5 muss gemergt sein (ChatView ist lazy → Prefetch macht Sinn)  
**UX-Impact:** niedrig–mittel (Thread-Navigation)  
**Risiko:** sehr niedrig  
**Aufwand:** ~0.5 Tage

### Problem

Nach Phase 5 ist `ChatView` lazy geladen. Thread-Navigationsklicks triggern erst dann  
den Chunk-Download. Mit intent-basiertem Prefetching auf Hover lädt der Browser den  
Chunk schon vor dem Klick.

---

### Task 7.1 — Thread-Link Prefetch auf Hover

**Datei:** `apps/web/src/components/Sidebar.tsx` (Thread-Item Link/Button)

```tsx
import { useRouter } from "@tanstack/react-router";

// Im Thread-Item:
const router = useRouter();

<ThreadItem
  onMouseEnter={() => {
    void router.preloadRoute({
      to: "/$threadId",
      params: { threadId: thread.id },
    });
  }}
/>;
```

TanStack Router handled `import()` intern — der `ChatView`-Chunk wird im Hintergrund  
geladen bevor der User klickt.

---

### Task 7.2 — Google Fonts render-blocking absichern

**Datei:** `apps/web/index.html`

Sicherstellen dass `preconnect` Hints korrekt gesetzt sind und `display=swap` in der  
Google Fonts URL enthalten ist. Falls nicht:

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=...&display=swap" rel="stylesheet" />
```

Optional für maximalen Effekt: Font-Dateien ins Repo und CDN-Abhängigkeit eliminieren.

### Acceptance Criteria Phase 7

- [ ] Thread-Wechsel bei Hover→Click fühlt sich schneller an als ohne Prefetch
- [ ] Kein übermäßiges Prefetching (nur on-hover, nicht on-render für alle Threads gleichzeitig)
- [ ] `bun fmt && bun lint && bun typecheck` grün

---

## Gesamtübersicht

| Phase            | Branch                                | UX-Impact      | Risiko       | Aufwand | Abhängigkeit |
| ---------------- | ------------------------------------- | -------------- | ------------ | ------- | ------------ |
| P1 Skeletons     | `feat/perf-p1-skeletons`              | sehr hoch      | niedrig      | 1.5T    | —            |
| P2 Timer         | `feat/perf-p2-timer-isolation`        | hoch           | sehr niedrig | 0.5T    | —            |
| P4 Markdown      | `feat/perf-p4-markdown-defer`         | mittel         | niedrig      | 0.5T    | —            |
| P3 Subscriptions | `feat/perf-p3-subscription-narrowing` | hoch           | mittel       | 2T      | —            |
| P5 Splitting     | `feat/perf-p5-code-splitting`         | mittel         | mittel       | 2T      | P1 gemergt   |
| P6 useOptimistic | `feat/perf-p6-optimistic-ui`          | mittel         | niedrig      | 1T      | —            |
| P7 Prefetching   | `feat/perf-p7-prefetching`            | niedrig–mittel | sehr niedrig | 0.5T    | P5 gemergt   |

**Gesamt:** ~8 Tage | Parallelisierbar auf ~4 Tage mit 2–3 gleichzeitigen Worktrees

---

## Quellen

- `apps/web/src/routes/__root.tsx:47` — Root connect state
- `apps/web/src/routes/_chat.$threadId.tsx:211` — Thread null guard
- `apps/web/src/components/ChatView.tsx:419,540,1096,2627` — nowTick, threads subscription
- `apps/web/src/components/ChatMarkdown.tsx:242,302` — Markdown sync parsing
- `apps/web/src/components/Sidebar.tsx:340,350,360` — relativeTimeNow, O(n) derivations
- `apps/web/src/components/ui/skeleton.tsx` — Skeleton primitive
- `apps/web/src/components/DiffPanelShell.tsx:46` — Referenz-Skeleton-Implementation
- `apps/web/vite.config.ts` — Build config
- React `useOptimistic`: https://react.dev/reference/react/useOptimistic
- React `Suspense`: https://react.dev/reference/react/Suspense
- React `lazy`: https://react.dev/reference/react/lazy
- Vite build features: https://vite.dev/guide/features
- web.dev prefetch: https://web.dev/articles/link-prefetch
- web.dev rendering: https://web.dev/articles/rendering-performance
