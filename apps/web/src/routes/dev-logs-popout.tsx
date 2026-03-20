import { ProjectId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { DevLogsPanel } from "~/components/chat/DevLogsPanel";
import { PopoutReceiver } from "~/lib/devLogsPopoutChannel";
import { readNativeApi } from "~/nativeApi";
import { useStore } from "~/store";

export const Route = createFileRoute("/dev-logs-popout")({
  component: DevLogsPopoutPage,
});

function DevLogsPopoutPage() {
  const devServerByProjectId = useStore((s) => s.devServerByProjectId);
  const devServerLogsByProjectId = useStore((s) => s.devServerLogsByProjectId);
  const projects = useStore((s) => s.projects);

  const [displayProjectId, setDisplayProjectId] = useState<string | null>(null);
  const [displayProjectName, setDisplayProjectName] = useState("Dev Logs");
  const [fallbackServerUrl, setFallbackServerUrl] = useState<string | null>(null);
  const [fallbackPackageManager, setFallbackPackageManager] = useState<string | null>(null);

  // Keeps one PopoutReceiver alive for the lifetime of this component
  const receiverRef = useRef<PopoutReceiver | null>(null);

  // Set up the BroadcastChannel receiver once on mount
  useEffect(() => {
    const receiver = (receiverRef.current = new PopoutReceiver());

    const unsub = receiver.onMessage((msg) => {
      // Use msg.devServerRunning (computed fresh by the main window) instead of
      // checking our local store. The onMessage callback is created once on mount
      // with [] deps, so devServerByProjectId would be a stale empty object —
      // always undefined, causing the switch to silently never happen.
      if (msg.devServerRunning) {
        setDisplayProjectId(msg.projectId);
        setDisplayProjectName(msg.projectName);
        setFallbackServerUrl(msg.serverUrl ?? null);
        setFallbackPackageManager(msg.packageManager ?? null);
      }
    });

    // Tell the main window we are ready so it re-sends the current active project.
    receiver.requestSync();

    return () => {
      unsub();
      receiver.close();
      receiverRef.current = null;
    };
  }, []);

  // Seed the initial target from local state, but do not replace an existing
  // target when the newly selected project has no running server.
  useEffect(() => {
    if (displayProjectId !== null) {
      return;
    }
    const running = Object.values(devServerByProjectId).find((s) => s.status === "running");
    if (running) {
      setDisplayProjectId(running.projectId);
      setDisplayProjectName(
        projects.find((project) => project.id === running.projectId)?.name ?? "Dev Logs",
      );
      setFallbackServerUrl(running.url ?? null);
      setFallbackPackageManager(running.packageManager ?? null);
    } else if (displayProjectId === null && receiverRef.current) {
      receiverRef.current.requestSync();
    }
  }, [devServerByProjectId, displayProjectId, projects]);

  useEffect(() => {
    if (!displayProjectId) {
      return;
    }
    const projectName = projects.find((project) => project.id === displayProjectId)?.name;
    if (projectName) {
      setDisplayProjectName(projectName);
    }
  }, [displayProjectId, projects]);

  // Keep document title in sync with the displayed project
  useEffect(() => {
    document.title = displayProjectName ? `Dev Logs — ${displayProjectName}` : "Dev Logs";
  }, [displayProjectName]);

  // Hard-restart: stop the running server, wait briefly, then start it again
  const handleRestart = useCallback(async () => {
    if (!displayProjectId) return;
    const api = readNativeApi();
    if (!api) return;

    const project = projects.find((p) => p.id === displayProjectId);
    if (!project?.cwd) return;

    const projectId = ProjectId.makeUnsafe(displayProjectId);
    await api.devServer.restart({ projectId, cwd: project.cwd });
  }, [displayProjectId, projects]);

  const logs = displayProjectId !== null ? (devServerLogsByProjectId[displayProjectId] ?? []) : [];
  const serverInfo = displayProjectId !== null ? devServerByProjectId[displayProjectId] : undefined;
  const resolvedServerUrl = serverInfo?.url ?? fallbackServerUrl ?? undefined;
  const resolvedPackageManager = serverInfo?.packageManager ?? fallbackPackageManager ?? undefined;
  const resolvedStatus = serverInfo?.status ?? (resolvedServerUrl ? "running" : undefined);

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      {displayProjectId === null ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">Waiting for a running dev server…</p>
        </div>
      ) : (
        <DevLogsPanel
          logs={logs}
          status={resolvedStatus}
          error={serverInfo?.error}
          recoveryHint={serverInfo?.recoveryHint}
          conflictingPid={serverInfo?.conflictingPid}
          serverUrl={resolvedServerUrl}
          packageManager={resolvedPackageManager}
          projectName={displayProjectName}
          onRestart={handleRestart}
          isPopout={true}
          className="flex-1"
        />
      )}
    </div>
  );
}
