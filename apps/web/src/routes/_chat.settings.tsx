/**
 * Settings page — full-page fallback for direct URL access (/settings).
 *
 * The primary settings entry point is SettingsModal (opened from the sidebar
 * Settings button). This page exists so /settings still renders something
 * useful if accessed directly or bookmarked.
 */
import { createFileRoute } from "@tanstack/react-router";
import { isElectron } from "../env";
import { SidebarInset } from "~/components/ui/sidebar";
import { SettingsPanel, type SettingsSectionId } from "../components/SettingsPanel";

export const Route = createFileRoute("/_chat/settings")({
  component: SettingsPageView,
  validateSearch: (search: Record<string, unknown>): { section?: string } => {
    if (typeof search.section === "string") {
      return { section: search.section };
    }
    return {};
  },
});

function SettingsPageView() {
  const { section } = Route.useSearch();

  return (
    <SidebarInset className="isolate h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <div className="flex h-full min-h-0 flex-col">
        {isElectron && (
          <div className="drag-region flex h-[52px] shrink-0 items-center border-b border-border px-5">
            <span className="text-xs font-medium tracking-wide text-muted-foreground/70">
              Settings
            </span>
          </div>
        )}
        <div className="min-h-0 flex-1">
          <SettingsPanel defaultSection={section as SettingsSectionId | undefined} />
        </div>
      </div>
    </SidebarInset>
  );
}
