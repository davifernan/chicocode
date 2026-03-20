/**
 * SettingsModal - Full settings UI in a large dialog overlay.
 *
 * Wraps SettingsPanel (sidebar-nav + content panel) in a Dialog so
 * settings never replace the current chat view.
 *
 * Header includes a manual Sync button that force-saves all settings to the
 * server DB (local or remote, depending on which transport is active).
 *
 * @module SettingsModal
 */
import { useState } from "react";
import { Dialog, DialogBackdrop, DialogPortal, DialogViewport } from "./ui/dialog";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { CheckIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { Button } from "./ui/button";
import { SettingsPanel, type SettingsSectionId } from "./SettingsPanel";
import { forceSyncAppSettingsToServer } from "../appSettings";

// ── Sync button state ─────────────────────────────────────────────────

type SyncState = "idle" | "syncing" | "saved" | "error";

function SyncButton() {
  const [state, setState] = useState<SyncState>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSync = async () => {
    if (state === "syncing") return;
    setState("syncing");
    setErrorMsg(null);

    try {
      await forceSyncAppSettingsToServer();
      setState("saved");
      // Reset to idle after 2 s
      setTimeout(() => setState("idle"), 2_000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Sync failed";
      setErrorMsg(msg);
      setState("error");
      setTimeout(() => setState("idle"), 3_000);
    }
  };

  if (state === "saved") {
    return (
      <div className="flex items-center gap-1.5 rounded-md bg-green-500/10 px-2.5 py-1 text-xs font-medium text-green-600 dark:text-green-400">
        <CheckIcon className="size-3.5" />
        Saved
      </div>
    );
  }

  if (state === "error") {
    return (
      <div
        className="max-w-[200px] truncate rounded-md bg-destructive/10 px-2.5 py-1 text-xs text-destructive"
        title={errorMsg ?? undefined}
      >
        {errorMsg ?? "Sync failed"}
      </div>
    );
  }

  return (
    <Button
      size="xs"
      variant="ghost"
      className="gap-1.5 text-muted-foreground hover:text-foreground"
      onClick={() => void handleSync()}
      disabled={state === "syncing"}
      title="Save all settings to server"
    >
      <RefreshCwIcon className={state === "syncing" ? "size-3.5 animate-spin" : "size-3.5"} />
      {state === "syncing" ? "Saving…" : "Save"}
    </Button>
  );
}

// ── Modal ─────────────────────────────────────────────────────────────

interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultSection?: SettingsSectionId | undefined;
}

export function SettingsModal({ open, onOpenChange, defaultSection }: SettingsModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogViewport className="p-6">
          <DialogPrimitive.Popup className="relative row-start-2 flex h-[82vh] max-h-[740px] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border bg-popover text-popover-foreground shadow-lg/5 transition-[scale,opacity,translate] duration-200 ease-in-out will-change-transform data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0 not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]">
            {/* Header */}
            <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3">
              <span className="text-sm font-semibold text-foreground">Settings</span>
              <div className="flex items-center gap-1">
                <SyncButton />
                <DialogPrimitive.Close
                  aria-label="Close settings"
                  render={<Button size="icon" variant="ghost" className="size-7" />}
                >
                  <XIcon className="size-4" />
                </DialogPrimitive.Close>
              </div>
            </div>

            {/* Panel — fills remaining height */}
            <div className="min-h-0 flex-1">
              <SettingsPanel defaultSection={defaultSection} />
            </div>
          </DialogPrimitive.Popup>
        </DialogViewport>
      </DialogPortal>
    </Dialog>
  );
}
