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

  // Whenever devServerByProjectId changes: auto-select or re-request sync
  useEffect(() => {
    if (displayProjectId !== null && devServerByProjectId[displayProjectId]?.status === "running") {
      return;
    }
    const running = Object.values(devServerByProjectId).find((s) => s.status === "running");
    if (running) {
      setDisplayProjectId(running.projectId);
    } else if (displayProjectId === null && receiverRef.current) {
      receiverRef.current.requestSync();
    }
  }, [devServerByProjectId, displayProjectId]);

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
    await api.devServer.stop({ projectId });
    await new Promise<void>((r) => setTimeout(r, 800));
    await api.devServer.start({ projectId, cwd: project.cwd });
  }, [displayProjectId, projects]);

  const logs = displayProjectId !== null ? (devServerLogsByProjectId[displayProjectId] ?? []) : [];
  const serverInfo = displayProjectId !== null ? devServerByProjectId[displayProjectId] : undefined;

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      {displayProjectId === null ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">Waiting for a running dev server…</p>
        </div>
      ) : (
        <DevLogsPanel
          logs={logs}
          serverUrl={serverInfo?.url}
          packageManager={serverInfo?.packageManager}
          projectName={displayProjectName}
          onRestart={handleRestart}
          isPopout={true}
          className="flex-1"
        />
      )}
    </div>
  );
}
