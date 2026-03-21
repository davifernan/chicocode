/**
 * RemoteHostSettingsForm - Reusable form for configuring the remote host connection.
 *
 * Renders the enable toggle, SSH/server fields, test-connection flow,
 * live status banner, and save/disconnect actions.
 *
 * Does NOT include an outer section wrapper or heading — callers provide that
 * context (settings page wraps it in a <section>, the modal wraps it in a
 * DialogPanel).
 *
 * @module RemoteHostSettingsForm
 */
import { useCallback, useEffect, useState } from "react";
import type {
  RemoteConnectionStatus,
  RemoteConnectionStepResult,
  RemoteHostConfig,
} from "@t3tools/contracts";

import { loadRemoteHostConfig, testRemoteConnection } from "../remoteHostConfig";
import { readNativeApi } from "../nativeApi";
import { REMOTE_STATUS_EVENT } from "../main";
import type { RemoteStatusEvent } from "../main";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";

// ── Constants ─────────────────────────────────────────────────────────

export const REMOTE_HOST_EMPTY_CONFIG: RemoteHostConfig = {
  host: "",
  sshPort: 22,
  sshUser: "",
  sshKeyPath: "",
  sshPassword: null,
  remoteServerPort: 3773,
  remoteAuthToken: null,
  enabled: false,
  autoCloneGitProjects: true,
  remoteWorkspaceBase: "",
};

// ── Helpers ────────────────────────────────────────────────────────────

function StepIcon({ result }: { result: RemoteConnectionStepResult }) {
  if (result.ok) return <span className="text-green-500">✓</span>;
  return <span className="text-destructive">✗</span>;
}

// ── Component ──────────────────────────────────────────────────────────

export function RemoteHostSettingsForm() {
  const [config, setConfig] = useState<RemoteHostConfig>(REMOTE_HOST_EMPTY_CONFIG);
  const [connectionStatus, setConnectionStatus] = useState<RemoteConnectionStatus | null>(null);
  const [testSteps, setTestSteps] = useState<RemoteConnectionStepResult[] | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Load saved config on mount
  useEffect(() => {
    void loadRemoteHostConfig().then((saved) => {
      if (saved) setConfig(saved);
    });
  }, []);

  // Subscribe to remote connection status
  useEffect(() => {
    const handler = (e: Event) => setConnectionStatus((e as RemoteStatusEvent).detail);
    window.addEventListener(REMOTE_STATUS_EVENT, handler);
    return () => window.removeEventListener(REMOTE_STATUS_EVENT, handler);
  }, []);

  const handleTest = useCallback(async () => {
    setIsTesting(true);
    setTestSteps(null);
    try {
      const result = await testRemoteConnection(config);
      setTestSteps(Array.from(result.steps));
    } catch (err) {
      setTestSteps([
        {
          step: "ssh-connect",
          ok: false,
          error: err instanceof Error ? err.message : "Unknown error",
          hint: null,
        },
      ]);
    } finally {
      setIsTesting(false);
    }
  }, [config]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    setSaveError(null);
    try {
      const api = readNativeApi();
      if (!api) throw new Error("API not available");
      await api.remoteHost.setConfig(config.enabled ? config : null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save config");
    } finally {
      setIsSaving(false);
    }
  }, [config]);

  const handleDisconnect = useCallback(() => {
    setConfig(REMOTE_HOST_EMPTY_CONFIG);
    const api = readNativeApi();
    if (api) void api.remoteHost.setConfig(null);
  }, []);

  const isConnected = connectionStatus?.status === "connected";
  const isConnecting = connectionStatus?.status === "connecting";

  return (
    <div className="space-y-4">
      {/* Enable toggle */}
      <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
        <div>
          <p className="text-sm font-medium text-foreground">Enable Remote Mode</p>
          <p className="text-xs text-muted-foreground">
            When enabled, T3 will establish the SSH tunnel on save.
          </p>
        </div>
        <Switch
          checked={config.enabled}
          onCheckedChange={(checked) => setConfig((c) => ({ ...c, enabled: checked }))}
        />
      </div>

      {/* Form fields */}
      <div className="space-y-3">
        <div className="grid grid-cols-[1fr_6rem] gap-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Host</label>
            <Input
              value={config.host}
              onChange={(e) => setConfig((c) => ({ ...c, host: e.target.value }))}
              placeholder="remote.example.com"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">SSH Port</label>
            <Input
              type="number"
              value={config.sshPort}
              onChange={(e) => setConfig((c) => ({ ...c, sshPort: Number(e.target.value) }))}
            />
          </div>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">SSH User</label>
          <Input
            value={config.sshUser}
            onChange={(e) => setConfig((c) => ({ ...c, sshUser: e.target.value }))}
            placeholder="ubuntu"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            SSH Key Path
          </label>
          <Input
            value={config.sshKeyPath}
            onChange={(e) => setConfig((c) => ({ ...c, sshKeyPath: e.target.value }))}
            placeholder="~/.ssh/id_rsa"
          />
        </div>

        <div className="grid grid-cols-[1fr_6rem] gap-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Auth Token <span className="text-muted-foreground/50">(optional)</span>
            </label>
            <Input
              type="password"
              value={config.remoteAuthToken ?? ""}
              onChange={(e) =>
                setConfig((c) => ({
                  ...c,
                  remoteAuthToken: e.target.value.length > 0 ? e.target.value : null,
                }))
              }
              placeholder="T3_AUTH_TOKEN"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Server Port
            </label>
            <Input
              type="number"
              value={config.remoteServerPort}
              onChange={(e) =>
                setConfig((c) => ({ ...c, remoteServerPort: Number(e.target.value) }))
              }
            />
          </div>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            Remote Workspace Path <span className="text-muted-foreground/50">(for auto-clone)</span>
          </label>
          <Input
            value={config.remoteWorkspaceBase}
            onChange={(e) => setConfig((c) => ({ ...c, remoteWorkspaceBase: e.target.value }))}
            placeholder="/home/user/projects"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Absolute path on the remote server where git projects will be cloned.
          </p>
        </div>
      </div>

      {/* Auto git clone toggle */}
      <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
        <div>
          <p className="text-sm font-medium text-foreground">Auto-clone git projects</p>
          <p className="text-xs text-muted-foreground">
            Automatically clone local git projects to the remote server on connect.
          </p>
        </div>
        <Switch
          checked={config.autoCloneGitProjects}
          onCheckedChange={(checked) => setConfig((c) => ({ ...c, autoCloneGitProjects: checked }))}
        />
      </div>

      {/* Test connection */}
      <div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void handleTest()}
          disabled={isTesting || !config.host || !config.sshUser}
        >
          {isTesting ? "Testing…" : "Test Connection"}
        </Button>

        {testSteps !== null && (
          <div className="mt-3 space-y-1 rounded-lg border border-border bg-background px-3 py-2">
            {testSteps.map((step) => (
              <div key={step.step} className="flex items-start gap-2 text-xs">
                <StepIcon result={step} />
                <div>
                  <span className="font-medium capitalize">{step.step.replace(/-/g, " ")}</span>
                  {step.ok ? (
                    <span className="ml-1 text-muted-foreground">OK</span>
                  ) : (
                    <>
                      {step.error !== null && (
                        <span className="ml-1 text-destructive">{step.error}</span>
                      )}
                      {step.hint !== null && (
                        <p className="mt-0.5 text-muted-foreground">{step.hint}</p>
                      )}
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Live connection status */}
      {connectionStatus !== null && connectionStatus.status !== "disconnected" && (
        <div
          className={`rounded-lg border px-3 py-2 text-xs ${
            isConnected
              ? "border-green-500/30 bg-green-500/10 text-green-600 dark:text-green-400"
              : isConnecting
                ? "border-yellow-500/30 bg-yellow-500/10 text-yellow-600 dark:text-yellow-400"
                : "border-destructive/30 bg-destructive/10 text-destructive"
          }`}
        >
          {isConnected && connectionStatus.tunnelWsUrl !== null
            ? `Connected — app switched to ${connectionStatus.tunnelWsUrl}`
            : isConnecting
              ? `Connecting… (${connectionStatus.step ?? "…"})`
              : `Error: ${connectionStatus.error ?? "Unknown error"}`}
        </div>
      )}

      {saveError !== null && <p className="text-xs text-destructive">{saveError}</p>}

      {/* Action buttons */}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void handleSave()} disabled={isSaving || !config.host}>
          {isSaving ? "Saving…" : "Save & Connect"}
        </Button>

        <Button variant="outline" size="sm" onClick={handleDisconnect}>
          Disconnect
        </Button>
      </div>
    </div>
  );
}
