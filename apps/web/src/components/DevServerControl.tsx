import type { DevServerInfo, ProjectId } from "@t3tools/contracts";
import { PlayIcon, SquareIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { ensureNativeApi } from "~/nativeApi";
import { toastManager } from "~/components/ui/toast";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

interface DevServerControlProps {
  projectId: ProjectId;
  cwd: string;
  devServerInfo: DevServerInfo | undefined;
}

export default function DevServerControl({ projectId, cwd, devServerInfo }: DevServerControlProps) {
  const [isLoading, setIsLoading] = useState(false);
  const status = devServerInfo?.status ?? "idle";
  const isRunning = status === "running";
  const isStarting = status === "starting" || isLoading;

  const handleStart = useCallback(async () => {
    if (isStarting || isRunning) return;
    setIsLoading(true);
    try {
      await ensureNativeApi().devServer.start({ projectId, cwd });
    } catch (err) {
      toastManager.add({
        type: "error",
        title: "Failed to start dev server",
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setIsLoading(false);
    }
  }, [projectId, cwd, isStarting, isRunning]);

  const handleStop = useCallback(() => {
    void ensureNativeApi().devServer.stop({ projectId });
  }, [projectId]);

  if (isRunning) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="xs"
              variant="outline"
              onClick={handleStop}
              className="shrink-0 text-emerald-600 hover:text-destructive dark:text-emerald-400"
              aria-label="Stop dev server"
            >
              <SquareIcon className="size-3 fill-current" />
              <span className="sr-only @sm/header-actions:not-sr-only @sm/header-actions:ml-0.5">
                Stop dev
              </span>
            </Button>
          }
        />
        <TooltipPopup side="bottom">
          {devServerInfo?.url
            ? `Stop dev server (running at ${devServerInfo.url})`
            : "Stop dev server"}
        </TooltipPopup>
      </Tooltip>
    );
  }

  if (isStarting) {
    return (
      <Button
        size="xs"
        variant="outline"
        disabled
        className="shrink-0"
        aria-label="Starting dev server"
      >
        <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
        <span className="sr-only @sm/header-actions:not-sr-only @sm/header-actions:ml-0.5">
          Starting…
        </span>
      </Button>
    );
  }

  const isError = status === "error";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="xs"
            variant="outline"
            onClick={handleStart}
            className={isError ? "shrink-0 border-destructive/50 text-destructive" : "shrink-0"}
            aria-label="Run dev server"
          >
            <PlayIcon className="size-3" />
            <span className="sr-only @sm/header-actions:not-sr-only @sm/header-actions:ml-0.5">
              {isError ? "Retry dev" : "Run dev"}
            </span>
          </Button>
        }
      />
      <TooltipPopup side="bottom">
        {isError && devServerInfo?.error
          ? `Error: ${devServerInfo.error}. Click to retry.`
          : "Start dev server (auto-detects package manager)"}
      </TooltipPopup>
    </Tooltip>
  );
}
