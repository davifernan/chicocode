import { MessageId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

function matchMedia() {
  return {
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

beforeAll(() => {
  const classList = {
    add: () => {},
    remove: () => {},
    toggle: () => {},
    contains: () => false,
  };

  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
  vi.stubGlobal("window", {
    matchMedia,
    addEventListener: () => {},
    removeEventListener: () => {},
    desktopBridge: undefined,
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList,
      offsetHeight: 0,
    },
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
});

// Shared minimal props for the new prop interface (nowIso removed — managed internally).
function makeBaseProps() {
  return {
    hasMessages: true,
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnStartedAt: null,
    scrollContainer: null,
    timelineEntries: [],
    completionDividerBeforeEntryId: null,
    completionSummary: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    expandedWorkGroups: {},
    onToggleWorkGroup: () => {},
    onOpenTurnDiff: () => {},
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    markdownCwd: undefined,
    resolvedTheme: "light" as const,
    timestampFormat: "locale" as const,
    workspaceRoot: undefined,
  };
}

describe("MessagesTimeline", () => {
  it("renders inline terminal labels with the composer chip UI", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-2"),
              role: "user",
              text: [
                "yoo what's @terminal-1:1-5 mean",
                "",
                "<terminal_context>",
                "- Terminal 1 lines 1-5:",
                "  1 | julius@mac effect-http-ws-cli % bun i",
                "  2 | bun install v1.3.9 (cf6cdbbb)",
                "</terminal_context>",
              ].join("\n"),
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Terminal 1 lines 1-5");
    expect(markup).toContain("lucide-terminal");
    expect(markup).toContain("yoo what&#x27;s ");
  });

  it("renders a dedicated inline subagent card with nested internals", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "subagent:child-1",
            kind: "subagent",
            createdAt: "2026-03-18T12:00:00.000Z",
            subagent: {
              childSessionId: "child-1",
              title: "Research helper",
              status: "completed",
              inputText: "Inspect the parser regression",
              outputText: "The tokenizer strips escaped pipes before parsing.",
              startedAt: "2026-03-18T12:00:00.000Z",
              completedAt: "2026-03-18T12:00:04.000Z",
              internals: [
                {
                  id: "subagent-tool-1",
                  createdAt: "2026-03-18T12:00:01.000Z",
                  label: "Glob",
                  detail: "src/**/*.ts",
                  tone: "tool",
                  toolTitle: "Glob",
                  itemType: "dynamic_tool_call",
                  childSessionId: "child-1",
                },
              ],
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{ "subagent:child-1": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain('data-subagent-card="true"');
    expect(markup).toContain("Research helper");
    expect(markup).toContain("Runtime");
    expect(markup).toContain('aria-label="Collapse subagent details"');
    expect(markup).toContain("Inspect the parser regression");
    expect(markup).toContain("The tokenizer strips escaped pipes before parsing.");
    expect(markup).toContain("1 runtime event");
    expect(markup).toContain("src/**/*.ts");
  });

  it("renders deliberate running subagent output state copy", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "subagent:child-2",
            kind: "subagent",
            createdAt: "2026-03-18T12:00:00.000Z",
            subagent: {
              childSessionId: "child-2",
              title: "Search helper",
              status: "running",
              inputText: "Scan for websocket retry regressions",
              startedAt: "2026-03-18T12:00:00.000Z",
              internals: [],
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Search helper");
    expect(markup).toContain("Runtime");
    expect(markup).toContain('aria-label="Expand subagent details"');
    expect(markup).not.toContain("Awaiting final output");
  });

  it("renders the Working indicator when isWorking=true with a start timestamp", async () => {
    // The "working" row is generated internally by MessagesTimeline when isWorking=true.
    // Previously this required the caller to pass a nowIso prop — now it is self-managed.
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...makeBaseProps()}
        isWorking
        activeTurnInProgress
        activeTurnStartedAt="2026-03-19T10:00:00.000Z"
        timelineEntries={[]}
      />,
    );

    // The component renders either "Working for Xs" or "Working..." depending on timing.
    // Both variations contain "Working".
    expect(markup).toMatch(/Working/);
  });

  it("renders 'Working...' when isWorking=true but no start timestamp is available", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...makeBaseProps()}
        isWorking
        activeTurnInProgress
        activeTurnStartedAt={null}
        timelineEntries={[]}
      />,
    );

    expect(markup).toContain("Working...");
  });

  it("does not render the Working indicator when isWorking=false", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...makeBaseProps()}
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[]}
      />,
    );

    expect(markup).not.toMatch(/Working for/);
    expect(markup).not.toContain("Working...");
  });

  it("renders correctly without nowIso prop (nowIso is now internal)", async () => {
    // Regression guard: the prop interface no longer has nowIso.
    // TypeScript enforces this at compile time; this test documents the intent
    // and verifies the component renders without crashing under the new interface.
    const { MessagesTimeline } = await import("./MessagesTimeline");
    expect(() => renderToStaticMarkup(<MessagesTimeline {...makeBaseProps()} />)).not.toThrow();
  });
});
