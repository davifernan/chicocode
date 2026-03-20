import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { vi } from "vitest";

// ---------------------------------------------------------------------------
// Browser globals required by isElectron + cn
// ---------------------------------------------------------------------------

function makeWindowStub(opts: { isElectron?: boolean } = {}) {
  return {
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
    addEventListener: () => {},
    removeEventListener: () => {},
    desktopBridge: opts.isElectron ? {} : undefined,
    nativeApi: undefined,
  };
}

describe("ChatViewSkeleton (web, non-Electron)", () => {
  beforeAll(() => {
    vi.stubGlobal("window", makeWindowStub({ isElectron: false }));
    vi.stubGlobal("document", {
      documentElement: {
        classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
        offsetHeight: 0,
      },
    });
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
    });
  });

  it("renders with role=status and an accessible aria-label", async () => {
    const { ChatViewSkeleton } = await import("./ChatViewSkeleton");
    const markup = renderToStaticMarkup(<ChatViewSkeleton />);

    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-label="Lade Unterhaltung..."');
  });

  it("renders a header element", async () => {
    const { ChatViewSkeleton } = await import("./ChatViewSkeleton");
    const markup = renderToStaticMarkup(<ChatViewSkeleton />);

    expect(markup).toContain("<header");
  });

  it("renders skeleton shimmer elements (data-slot=skeleton)", async () => {
    const { ChatViewSkeleton } = await import("./ChatViewSkeleton");
    const markup = renderToStaticMarkup(<ChatViewSkeleton />);

    // Skeleton component sets data-slot="skeleton"
    expect(markup).toContain('data-slot="skeleton"');
    // There should be many skeleton elements
    const count = (markup.match(/data-slot="skeleton"/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(8);
  });

  it("renders the non-Electron header variant (py-2 class, no drag-region)", async () => {
    const { ChatViewSkeleton } = await import("./ChatViewSkeleton");
    const markup = renderToStaticMarkup(<ChatViewSkeleton />);

    expect(markup).not.toContain("drag-region");
    expect(markup).not.toContain("h-[52px]");
    expect(markup).toContain("py-2");
  });

  it("renders assistant message shapes matching real assistant layout (px-1 py-0.5, max-w-3xl)", async () => {
    const { ChatViewSkeleton } = await import("./ChatViewSkeleton");
    const markup = renderToStaticMarkup(<ChatViewSkeleton />);

    // Assistant messages sit in px-1 py-0.5, inside max-w-3xl container (matches MessagesTimeline:618)
    expect(markup).toContain("max-w-3xl");
    expect(markup).toContain("px-1");
  });

  it("renders user message bubbles matching real bubble style (bg-secondary, border-border, rounded-2xl rounded-br-sm)", async () => {
    const { ChatViewSkeleton } = await import("./ChatViewSkeleton");
    const markup = renderToStaticMarkup(<ChatViewSkeleton />);

    // Exact classes from MessagesTimeline:398
    expect(markup).toContain("bg-secondary");
    expect(markup).toContain("border-border");
    expect(markup).toContain("rounded-2xl");
    expect(markup).toContain("rounded-br-sm");
    expect(markup).toContain("justify-end");
    expect(markup).toContain("max-w-[80%]");
  });

  it("renders the composer card skeleton matching real composer (rounded-[20px], bg-card, send button)", async () => {
    const { ChatViewSkeleton } = await import("./ChatViewSkeleton");
    const markup = renderToStaticMarkup(<ChatViewSkeleton />);

    // Real composer card: rounded-[20px] border border-border bg-card (ChatView:4217)
    expect(markup).toContain("rounded-[20px]");
    expect(markup).toContain("bg-card");
    // Has a circular send button (rounded-full size-8)
    expect(markup).toContain("rounded-full");
    // Has textarea space (min-h-[70px])
    expect(markup).toContain("min-h-[70px]");
    // Token count pill
    expect(markup).toContain("rounded-full");
  });

  it("ChatViewMessagesSkeleton: no header/composer, pinned to bottom, matches real bubble classes", async () => {
    const { ChatViewMessagesSkeleton } = await import("./ChatViewSkeleton");
    const markup = renderToStaticMarkup(<ChatViewMessagesSkeleton />);

    expect(markup).not.toContain("<header");
    // Pinned to bottom so there's no layout shift when real messages load
    expect(markup).toContain("justify-end");
    expect(markup).toContain("min-h-full");
    // Real bubble classes
    expect(markup).toContain("bg-secondary");
    expect(markup).toContain("max-w-[80%]");
    expect(markup).toContain("rounded-br-sm");
  });
});

describe("ChatViewSkeleton (Electron)", () => {
  beforeAll(() => {
    vi.stubGlobal("window", makeWindowStub({ isElectron: true }));
  });

  it("renders the Electron drag-region header variant", async () => {
    // Reset module cache so isElectron re-evaluates with the new window stub.
    vi.resetModules();
    const { ChatViewSkeleton } = await import("./ChatViewSkeleton");
    const markup = renderToStaticMarkup(<ChatViewSkeleton />);

    expect(markup).toContain("drag-region");
    expect(markup).toContain("h-[52px]");
  });
});
