import { Outlet, createFileRoute, useNavigate } from "@tanstack/react-router";
import { type CSSProperties, useEffect } from "react";

import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import ThreadSidebar from "../components/Sidebar";
import { Sidebar, SidebarProvider, SidebarRail } from "~/components/ui/sidebar";

const CHAT_SIDEBAR_WIDTH_STORAGE_KEY = "chat_threads_sidebar_width";
const CHAT_SIDEBAR_DEFAULT_WIDTH = "clamp(17rem,22vw,28rem)";
const CHAT_SIDEBAR_MIN_WIDTH = 14 * 16;
const CHAT_SIDEBAR_MAX_WIDTH = 34 * 16;

function ChatRouteLayout() {
  const navigate = useNavigate();

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action !== "open-settings") return;
      void navigate({ to: "/settings" });
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate]);

  return (
    <SidebarProvider
      defaultOpen
      style={{ "--sidebar-width": CHAT_SIDEBAR_DEFAULT_WIDTH } as CSSProperties}
    >
      <Sidebar
        side="left"
        collapsible="offcanvas"
        className="border-r border-border bg-card text-foreground"
        resizable={{
          minWidth: CHAT_SIDEBAR_MIN_WIDTH,
          maxWidth: CHAT_SIDEBAR_MAX_WIDTH,
          storageKey: CHAT_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        <ThreadSidebar />
        <SidebarRail />
      </Sidebar>
      <DiffWorkerPoolProvider>
        <Outlet />
      </DiffWorkerPoolProvider>
    </SidebarProvider>
  );
}

export const Route = createFileRoute("/_chat")({
  component: ChatRouteLayout,
});
