import {
  type EditorId,
  type DevServerInfo,
  type ProjectId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { memo, useRef } from "react";
import GitActionsControl from "../GitActionsControl";
import { Badge } from "../ui/badge";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptsControlHandle,
} from "../ProjectScriptsControl";
import { SidebarTrigger } from "../ui/sidebar";
import { OpenInPicker } from "./OpenInPicker";
import DevServerControl from "../DevServerControl";
import { DiffPanelButton, DevLogsPanelButton, type RightPanelMode } from "../RightPanelControl";

export type { RightPanelMode };

interface ChatHeaderProps {
  activeThreadId: ThreadId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  activeProjectId: ProjectId | undefined;
  activeProjectCwd: string | undefined;
  isGitRepo: boolean;
  openInCwd: string | null;
  activeProjectScripts: ProjectScript[] | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  diffToggleShortcutLabel: string | null;
  gitCwd: string | null;
  rightPanelMode: RightPanelMode | null;
  devServerInfo: DevServerInfo | undefined;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  onRightPanelModeChange: (mode: RightPanelMode | null) => void;
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadId,
  activeThreadTitle,
  activeProjectName,
  activeProjectId,
  activeProjectCwd,
  isGitRepo,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  diffToggleShortcutLabel,
  gitCwd,
  rightPanelMode,
  devServerInfo,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onRightPanelModeChange,
}: ChatHeaderProps) {
  const scriptsControlRef = useRef<ProjectScriptsControlHandle>(null);
  const onAddAction: (() => void) | undefined =
    activeProjectScripts !== undefined
      ? () => {
          scriptsControlRef.current?.openAddDialog();
        }
      : undefined;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
        <SidebarTrigger className="size-7 shrink-0 md:hidden" />
        <h2
          className="min-w-0 shrink truncate text-sm font-medium text-foreground"
          title={activeThreadTitle}
        >
          {activeThreadTitle}
        </h2>
        {activeProjectName && (
          <Badge variant="outline" className="min-w-0 shrink truncate">
            {activeProjectName}
          </Badge>
        )}
        {activeProjectName && !isGitRepo && (
          <Badge variant="outline" className="shrink-0 text-[10px] text-amber-700">
            No Git
          </Badge>
        )}
      </div>
      <div className="@container/header-actions flex min-w-0 flex-1 items-center justify-end gap-2 @sm/header-actions:gap-3">
        {activeProjectScripts && (
          <ProjectScriptsControl
            ref={scriptsControlRef}
            scripts={activeProjectScripts}
            keybindings={keybindings}
            preferredScriptId={preferredScriptId}
            onRunScript={onRunProjectScript}
            onAddScript={onAddProjectScript}
            onUpdateScript={onUpdateProjectScript}
            onDeleteScript={onDeleteProjectScript}
          />
        )}
        {activeProjectId && activeProjectCwd && (
          <DevServerControl
            projectId={activeProjectId}
            cwd={activeProjectCwd}
            devServerInfo={devServerInfo}
          />
        )}
        <DevLogsPanelButton
          active={rightPanelMode === "dev-logs"}
          onToggle={() => onRightPanelModeChange(rightPanelMode === "dev-logs" ? null : "dev-logs")}
        />
        {activeProjectName && (
          <OpenInPicker
            keybindings={keybindings}
            availableEditors={availableEditors}
            openInCwd={openInCwd}
            {...(onAddAction !== undefined ? { onAddAction } : {})}
          />
        )}
        {activeProjectName && <GitActionsControl gitCwd={gitCwd} activeThreadId={activeThreadId} />}
        <DiffPanelButton
          active={rightPanelMode === "diff"}
          isGitRepo={isGitRepo}
          shortcutLabel={diffToggleShortcutLabel}
          onToggle={() => onRightPanelModeChange(rightPanelMode === "diff" ? null : "diff")}
        />
      </div>
    </div>
  );
});
