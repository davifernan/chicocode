import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { vi } from "vitest";

// ---------------------------------------------------------------------------
// Browser globals required by isElectron
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

describe("AppShellSkeleton (web, non-Electron)", () => {
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

  it("renders without crashing", async () => {
    const { AppShellSkeleton } = await import("./AppShellSkeleton");
    expect(() => renderToStaticMarkup(<AppShellSkeleton />)).not.toThrow();
  });

  it("fills the full viewport height", async () => {
    const { AppShellSkeleton } = await import("./AppShellSkeleton");
    const markup = renderToStaticMarkup(<AppShellSkeleton />);

    expect(markup).toContain("h-screen");
  });

  it("renders a left sidebar panel (hidden on mobile, visible on md+)", async () => {
    const { AppShellSkeleton } = await import("./AppShellSkeleton");
    const markup = renderToStaticMarkup(<AppShellSkeleton />);

    // The sidebar panel uses md:flex to show on desktop
    expect(markup).toContain("md:flex");
    // Sidebar has a right border
    expect(markup).toContain("border-r");
  });

  it("renders a right main panel that takes remaining space", async () => {
    const { AppShellSkeleton } = await import("./AppShellSkeleton");
    const markup = renderToStaticMarkup(<AppShellSkeleton />);

    expect(markup).toContain("flex-1");
  });

  it("renders skeleton shimmer elements in the sidebar (projects + threads)", async () => {
    const { AppShellSkeleton } = await import("./AppShellSkeleton");
    const markup = renderToStaticMarkup(<AppShellSkeleton />);

    // Multiple skeleton elements should be present
    const skeletonCount = (markup.match(/data-slot="skeleton"/g) ?? []).length;
    expect(skeletonCount).toBeGreaterThanOrEqual(12);
  });

  it("embeds the ChatViewSkeleton in the right panel (role=status present)", async () => {
    const { AppShellSkeleton } = await import("./AppShellSkeleton");
    const markup = renderToStaticMarkup(<AppShellSkeleton />);

    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-label="Lade Unterhaltung..."');
  });

  it("renders the non-Electron sidebar header (no drag-region)", async () => {
    const { AppShellSkeleton } = await import("./AppShellSkeleton");
    const markup = renderToStaticMarkup(<AppShellSkeleton />);

    // In non-Electron mode, sidebar header uses py-2 / py-3 classes, not drag-region
    expect(markup).not.toContain("drag-region");
  });
});

describe("AppShellSkeleton (Electron)", () => {
  beforeAll(() => {
    vi.stubGlobal("window", makeWindowStub({ isElectron: true }));
  });

  it("renders the Electron sidebar header with drag-region and h-[52px]", async () => {
    vi.resetModules();
    const { AppShellSkeleton } = await import("./AppShellSkeleton");
    const markup = renderToStaticMarkup(<AppShellSkeleton />);

    expect(markup).toContain("drag-region");
    expect(markup).toContain("h-[52px]");
  });
});
