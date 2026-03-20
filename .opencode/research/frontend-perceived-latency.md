## 🔎 Research Report — Frontend Perceived Latency in Chicocode / T3 Code

Fragestellung

- Wie viel der gefuehlten Langsamkeit laesst sich realistisch im Frontend statt im Backend beheben?
- Welche Best Practices zu Optimistic UI, Suspense/Skeletons und Prefetching/Code Splitting sind fuer diese Codebase wirklich relevant?
- Was ist in `apps/web` bereits gut umgesetzt, was fehlt noch, und welche Aenderungen haben den groessten UX-Impact?

Research-Plan

- Offizielle React-, React DOM-, Vite- und Web-Performance-Docs fuer die drei Patterns auswerten.
- Die lokale Codebase mit Explore-Subagents auf vorhandene Implementierungen, Anti-Patterns und Gaps scannen.
- Die wichtigsten Befunde direkt an Kernfiles verifizieren.
- Daraus einen priorisierten Verbesserungsplan mit Tradeoffs ableiten.

Findings

1. Die Grundthese ist plausibel: Perceived Latency ist in React-SPAs oft primaer ein Frontend-Problem.
   - Evidence: React und web.dev betonen, dass Responsiveness von Rendering, Scheduling, Fallback-Strategien und Main-Thread-Arbeit abhaengt; bei 60 Hz bleiben effektiv ca. 10 ms Budget pro Frame, sonst entsteht Jank.
   - Source: `https://web.dev/articles/rendering-performance`, `https://react.dev/reference/react/Suspense`
   - Tradeoff: Backend-Latenz ist nicht irrelevant, aber ein schneller Server fuehlt sich trotzdem langsam an, wenn UI leer bleibt, blockiert oder komplett neu rendert.

2. Optimistic UI ist einer der staerksten Hebel fuer Mutations-UX, aber nur wenn sie sauber mit Transitions gekoppelt ist.
   - Evidence: React 19 `useOptimistic` ist genau fuer temporaere, serverbestaetigte UI-Zustaende gedacht; der Setter soll in einer Action oder `startTransition` laufen, Reducer sind empfohlen wenn sich die Basis waehrenddessen aendern kann.
   - Source: `https://react.dev/reference/react/useOptimistic`, `https://react.dev/blog/2024/12/05/react-19`
   - Tradeoff: Optimistische States koennen bei Fehlern sichtbar zurueckspringen; deshalb braucht man klare Pending-/Error-Signale und keinen stillen Rollback.

3. Chicocode/T3 Code nutzt Optimistic UI bereits an einer der wichtigsten Stellen, aber noch nicht systematisch.
   - Evidence: `apps/web/src/components/ChatView.tsx:505` haelt `optimisticUserMessages` lokal und zeigt User-Messages sofort; `apps/web/src/components/BranchToolbarBranchSelector.tsx:143` nutzt bereits echtes `useOptimistic` plus `useTransition` und `useDeferredValue`.
   - Source: `apps/web/src/components/ChatView.tsx:505`, `apps/web/src/components/BranchToolbarBranchSelector.tsx:143`
   - Tradeoff: Das ist gut, aber inkonsistent. Chat benutzt noch `useState` statt `useOptimistic`, und andere UI-Wege warten weiterhin staerker auf serverseitige Rueckmeldung als noetig.

4. Suspense ist nur dort stark, wo auch wirklich lazy geladen wird; fuer `useEffect`-Fetches hilft Suspense allein nicht.
   - Evidence: React dokumentiert explizit, dass Suspense nur fuer Suspense-faehige Datenquellen greift, nicht fuer Daten, die nach dem Mount in `useEffect` geladen werden.
   - Source: `https://react.dev/reference/react/Suspense`
   - Tradeoff: Wer nur ein Fallback um bestehende `useEffect`-Fetches legt, bekommt keine echte Progressive Reveal UX, sondern oft nur einen teureren Blank-State.

5. In eurer App ist Suspense sinnvoll vorhanden, aber nur punktuell.
   - Evidence: `apps/web/src/routes/_chat.$threadId.tsx:20` lazy-laedt `DiffPanel` mit `Suspense` und einem echten Skeleton-Fallback; `apps/web/src/components/ChatMarkdown.tsx:279` nutzt `Suspense` fuer Shiki-Code-Highlighting.
   - Source: `apps/web/src/routes/_chat.$threadId.tsx:20`, `apps/web/src/components/ChatMarkdown.tsx:279`
   - Tradeoff: Das Muster ist gut, aber die Hauptflaeche der App profitiert kaum davon, weil die groessten Komponenten weiter eager geladen und post-mount hydratisiert werden.

6. Das aktuell sichtbarste UX-Problem ist nicht ein Spinner, sondern Leere.
   - Evidence: Die Thread-Route rendert bei fehlender Hydration einfach `null`; der Root zeigt beim Start nur einen Text-Connect-State statt Layout-Skeletons.
   - Source: `apps/web/src/routes/_chat.$threadId.tsx:211`, `apps/web/src/routes/__root.tsx:47`
   - Tradeoff: Technisch korrekt, UX-seitig teuer. Ein leerer Screen fuehlt sich deutlich langsamer an als eine sofort sichtbare Layout-Struktur.

7. Skeletons sind Best Practice, wenn sie die Form des spaeteren Inhalts nachbilden statt nur generisch zu rotieren.
   - Evidence: React beschreibt Fallbacks als lightweight placeholders; fuer gute Reveal-Sequenzen sollen Boundaries an UX-Schnittstellen gesetzt werden, nicht pro Mini-Komponente. web.dev und Suspense-Beispiele zeigen shape-matched Loading States statt globaler Spinner.
   - Source: `https://react.dev/reference/react/Suspense`, `https://web.dev/articles/rendering-performance`
   - Tradeoff: Zu viele kleine Skeleton-Boundaries erzeugen eigenes Flackern; zu wenige sorgen fuer lange Leere.

8. In der Codebase existieren Skeleton-Bausteine, aber nicht dort, wo sie den groessten wahrgenommenen Effekt haetten.
   - Evidence: `apps/web/src/components/ui/skeleton.tsx` existiert; `DiffPanelShell` nutzt Skeletons. Dagegen zeigt die Haupt-Thread-Route keinen Skeleton-Frame, und der Root-Connect-State ist nur Text.
   - Source: `apps/web/src/components/ui/skeleton.tsx`, `apps/web/src/components/DiffPanelShell.tsx`, `apps/web/src/routes/_chat.$threadId.tsx:211`, `apps/web/src/routes/__root.tsx:47`
   - Tradeoff: Vorhandene Infrastruktur reduziert Implementierungsaufwand; der fehlende Teil ist Produktentscheidung und Komposition, nicht Basistechnik.

9. Code Splitting ist wirksam, wenn zuerst an Route- und Heavy-Dependency-Grenzen geschnitten wird.
   - Evidence: React `lazy()` und Vite Dynamic Imports bilden Split-Points; Vite splittet CSS fuer Async-Chunks automatisch, generiert `modulepreload` und optimiert Async-Chunk-Laden, damit gemeinsame Chunks parallel statt seriell geholt werden.
   - Source: `https://react.dev/reference/react/lazy`, `https://vite.dev/guide/features`
   - Tradeoff: Zu viele Mini-Chunks koennen Overhead erzeugen; Split-Punkte sollten an echte Kostenstellen wie Editor, Terminal, Diff, Markdown, Settings, Sidepanels sitzen.

10. Eure App splittet aktuell zu wenig von ihrem teuersten UI-Pfad.

- Evidence: `DiffPanel` wird lazy geladen, `ChatView` aber statisch importiert; `vite.config.ts` hat keine explizite Chunk-Strategie fuer schwere Libs.
- Source: `apps/web/src/routes/_chat.$threadId.tsx:5`, `apps/web/src/routes/_chat.$threadId.tsx:20`, `apps/web/vite.config.ts:66`
- Tradeoff: Das haelt die Konfiguration simpel, bedeutet aber, dass Navigation in die Haupt-Chat-Ansicht mehr Parse-/Execute-Kosten traegt als noetig.

11. Prefetching bringt am meisten, wenn es absichtsgetrieben und selektiv ist, nicht global.

- Evidence: web.dev empfiehlt `prefetch` nur fuer wahrscheinlich naechste Navigationsziele und warnt vor unnnoetigem Bandbreitenverbrauch; Prefetch laeuft mit niedrigster Prioritaet. React DOM bietet dafuer resource preloading APIs wie `preconnect`, `preload`, `preloadModule`, `preinit`.
- Source: `https://web.dev/articles/link-prefetch`, `https://react.dev/reference/react-dom`
- Tradeoff: Aggressives Prefetching auf langsamen Netzen oder fuer unklare Ziele verschwendet Daten und kann Mobil-UX verschlechtern.

12. In dieser Codebase fehlt derzeit sichtbares Route-/Data-Prefetching.

- Evidence: Es gibt keine Loader- oder Prefetch-Strategie in der Thread-Route; Thread-Daten werden nach Mount ueber Effekte und Snapshot-Syncs geholt. Explorer-Scan fand keine Route-Prefetch-Hinweise.
- Source: `apps/web/src/routes/_chat.$threadId.tsx`, `apps/web/src/components/ChatView.tsx`, Explore-Reports `ses_2f9685cafffer7kQc4LddieJoA`, `ses_2f9685c9effeQic5EB7UZ8nAQm`
- Tradeoff: Bei einer WebSocket-getriebenen Chat-App ist Data-Prefetch schwieriger als bei klassischem CRUD, aber Component-/Route-Prefetch bleibt trotzdem wertvoll.

13. Ein grosser Teil des gefuehlten Lags kommt wahrscheinlich von Render- und Subscription-Breite, nicht von Netzwerkwartezeit.

- Evidence: `ChatView` ist ein sehr grosser Monolith und subscribed auf `threads` und `projects` als Ganzes; `Sidebar` subscribed ebenfalls breit und macht pro Render Ableitungen ueber alle Threads; `ChatMarkdown` parsed Markdown synchron via `ReactMarkdown`/`remarkGfm`; `nowTick` in `ChatView` rendert waehrend aktiver Arbeit im Sekundentakt neu.
- Source: `apps/web/src/components/ChatView.tsx:418`, `apps/web/src/components/Sidebar.tsx:253`, `apps/web/src/components/ChatMarkdown.tsx:302`, Explore-Reports `ses_2f9685cafffer7kQc4LddieJoA`, `ses_2f9685c9effeQic5EB7UZ8nAQm`
- Tradeoff: Diese Probleme sind weniger sexy als Backend-Umbauten, aber meistens schneller und risikoaermer zu beheben.

14. Die Codebase hat schon einige starke Performance-Bausteine, was wichtig fuer die Priorisierung ist.

- Evidence: Virtualisierung in `MessagesTimeline`, Diff-Worker-Pool, Throttling von Domain-Event-Syncs, Shiki-Cache, React Compiler, `useDeferredValue` im Branch-Selector.
- Source: `apps/web/src/components/chat/MessagesTimeline.tsx:282`, `apps/web/src/routes/__root.tsx:217`, `apps/web/src/components/BranchToolbarBranchSelector.tsx:89`, Explore-Reports `ses_2f9685cafffer7kQc4LddieJoA`, `ses_2f9685c9effeQic5EB7UZ8nAQm`
- Tradeoff: Das spricht gegen einen kompletten Rewrite. Wahrscheinlicher ist: ein paar gezielte Umbauten liefern den groessten Effekt.

15. Die drei von dir genannten Patterns sind richtig, aber in dieser App ist ihre Reihenfolge leicht anders.

- Evidence: Der groesste sichtbare Gap ist aktuell nicht fehlende Optimistic UI beim Senden, sondern `blank/empty states`, `zu breite rerenders`, `zu wenig splitting der Hauptpfade`, und `kein intent-basiertes Prefetch`.
- Source: Synthese aus Code-Reads und Explore-Reports
- Tradeoff: Wenn man sofort nur `useOptimistic` ausrollt, gewinnt man etwas, aber nicht den vollen Lag-Effekt. Die staerkere erste Welle ist wahrscheinlich Skeletons + Route/View-Splitting + Subscription-Entkopplung.

Options considered

- Option A: Backend-first optimieren
  - Vorteil: Kann echte API-Wartezeiten reduzieren.
  - Nachteil: Loest nicht die Leere, Parse-Kosten, Re-Render-Jank oder post-mount Loading-UX.
- Option B: Perceived-performance first im Frontend
  - Vorteil: Schnellster Hebel auf gefuehlte Geschwindigkeit, geringeres Risiko, lokal messbar.
  - Nachteil: Wenn spaeter echte Backend-Bottlenecks auftauchen, braucht es trotzdem zweite Runde.
- Option C: Komplett-Refactor von ChatView
  - Vorteil: Langfristig sauber.
  - Nachteil: Hoher Eingriff, grosses Risiko, fuer kurzfristige UX-Verbesserung nicht noetig.

Tradeoffs

- `useOptimistic` ist stark fuer Mutationen, aber weniger wertvoll als Skeletons/Chunking wenn der Hauptschmerz beim initialen Render liegt.
- Suspense hilft nur mit passenden Daten-/Code-Ladegrenzen; ohne echte Split- oder Suspense-Data-Sources bleibt es oberflaechlich.
- Prefetching sollte intent-basiert und netzwerkbewusst sein; globales Prefetching ist in einer Desktop-/Electron-nahen App weniger gefaehrlich als mobil, aber immer noch nicht gratis.
- Chat-spezifischer Streaming-Content braucht Scheduling (`useDeferredValue`, `useTransition`) und engere Store-Selectoren, sonst fuehlt sich auch ein schneller Stream stotterig an.

Empfehlung

- Empfehlung: Frontend-first. Kein grosser Backend-Umbau, bevor die wahrnehmbaren Frontend-Latency-Hebel abgearbeitet sind.
- Why: Die Codebase zeigt bereits mehrere klare Frontend-UX- und Render-Gaps, die direkt auf perceived latency einzahlen und mit deutlich geringerem Risiko zu beheben sind als Backend-Rewrites.

Priorisierter Plan

1. Sofort sichtbare Leere entfernen
   - Fuehre echte Skeleton-Layouts fuer Root-Connect und Thread-Hydration ein statt `null` oder reinem Text.
   - Ziel: Nutzer sieht sofort Struktur statt Warten.
   - Files: `apps/web/src/routes/__root.tsx:47`, `apps/web/src/routes/_chat.$threadId.tsx:211`

2. Schwere Hauptpfade splitten
   - `ChatView` bzw. Teilbereiche wie Composer, Timeline, Sidepanels lazy laden oder modularisieren.
   - Ergaenze Vite-Chunking-Strategie fuer schwere Dependencies, falls Bundle-Analyse das bestaetigt.
   - Files: `apps/web/src/routes/_chat.$threadId.tsx:5`, `apps/web/vite.config.ts:66`

3. Render-Breite reduzieren
   - `ChatView` und `Sidebar` von Whole-Store-Subscriptions wegbringen, selektiver subscriben.
   - Sekundaere Tick-/Relative-Time-Updates isolieren, damit nicht ganze Views neu rendern.
   - Files: `apps/web/src/components/ChatView.tsx:418`, `apps/web/src/components/Sidebar.tsx:253`

4. Streaming-Rendering entlasten
   - `ChatMarkdown` auf Defer-/Scheduling-Muster pruefen, damit Markdown-Parsing bei Streaming nicht User-Interaktionen blockiert.
   - Files: `apps/web/src/components/ChatMarkdown.tsx:242`

5. Optimistic UI systematisieren
   - Bestehende Optimistic-Patterns auf `useOptimistic` + klare Pending/Error-States migrieren, zuerst in Chat-Send- und Branch-/Action-Flows.
   - Files: `apps/web/src/components/ChatView.tsx:505`, `apps/web/src/components/BranchToolbarBranchSelector.tsx:143`

6. Intent-basiertes Prefetching einfuehren
   - Wahrscheinliche naechste Route/Thread-Komponenten und evtl. relevante Query-Daten auf Hover/Fokus/Idle vorladen.
   - Netzqualitaet beruecksichtigen, kein blindes Global-Prefetch.

Open questions

- Wie gross ist der tatsaechliche Initial- und Route-Bundle-Anteil von `ChatView`, Lexical, Markdown, xterm und Diff-Stack? Dafuer braucht es Bundle-Analyse.
- Wie viel des wahrgenommenen Lags kommt waehrend aktiver Agent-Streams von `ChatMarkdown`/Timeline-Re-Measurement versus Store-Resync?
- Greift der React Compiler bei `ChatView` effektiv oder bailed er an kritischen Stellen aus?
- Welche Navigationen sind in der realen Nutzung am besten fuer intent-based prefetch geeignet: Thread-Wechsel, Settings, Diff-Panel, Dev Logs?

Evidence and source notes

- React `useOptimistic`: `https://react.dev/reference/react/useOptimistic`
- React Suspense: `https://react.dev/reference/react/Suspense`
- React lazy: `https://react.dev/reference/react/lazy`
- React DOM resource preloading APIs: `https://react.dev/reference/react-dom`
- Vite features/build optimizations: `https://vite.dev/guide/features`
- web.dev prefetch guidance: `https://web.dev/articles/link-prefetch`
- web.dev rendering performance: `https://web.dev/articles/rendering-performance`
- Local files: `apps/web/src/routes/_chat.$threadId.tsx`, `apps/web/src/routes/__root.tsx`, `apps/web/src/components/ChatView.tsx`, `apps/web/src/components/ChatMarkdown.tsx`, `apps/web/src/components/Sidebar.tsx`, `apps/web/src/components/BranchToolbarBranchSelector.tsx`, `apps/web/vite.config.ts`
