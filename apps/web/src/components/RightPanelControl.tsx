import { ChevronDownIcon, DiffIcon, TerminalIcon } from "lucide-react";
import { Button } from "./ui/button";
import { Group, GroupSeparator } from "./ui/group";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export type RightPanelMode = "diff" | "dev-logs";

interface RightPanelControlProps {
  panelMode: RightPanelMode | null;
  devServerRunning: boolean;
  isGitRepo: boolean;
  shortcutLabel: string | null;
  onPanelModeChange: (mode: RightPanelMode | null) => void;
}

export default function RightPanelControl({
  panelMode,
  devServerRunning,
  isGitRepo,
  shortcutLabel,
  onPanelModeChange,
}: RightPanelControlProps) {
  const primaryIcon =
    panelMode === "dev-logs" ? (
      <TerminalIcon className="size-3" />
    ) : (
      <DiffIcon className="size-3" />
    );

  const isActive = panelMode !== null;
  const diffDisabled = !isGitRepo;
  const devLogsDisabled = !devServerRunning;

  const handlePrimaryToggle = () => {
    if (panelMode === null) {
      // Open to default: prefer diff if git repo, else dev-logs if available
      if (isGitRepo) {
        onPanelModeChange("diff");
      } else if (devServerRunning) {
        onPanelModeChange("dev-logs");
      }
    } else {
      onPanelModeChange(null);
    }
  };

  const primaryTooltip = (() => {
    if (panelMode === "dev-logs") {
      return "Hide dev logs panel";
    }
    if (panelMode === "diff") {
      return shortcutLabel ? `Hide diff panel (${shortcutLabel})` : "Hide diff panel";
    }
    if (isGitRepo) {
      return shortcutLabel ? `Show diff panel (${shortcutLabel})` : "Show diff panel";
    }
    if (devServerRunning) {
      return "Show dev logs panel";
    }
    return "Diff panel unavailable (no git repo). Start a dev server to see logs.";
  })();

  return (
    <Group aria-label="Right panel">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="outline"
              onClick={handlePrimaryToggle}
              aria-label={isActive ? "Hide panel" : "Show panel"}
              aria-pressed={isActive}
              disabled={diffDisabled && devLogsDisabled}
              data-state={isActive ? "on" : "off"}
              className="shrink-0 data-[state=on]:bg-accent data-[state=on]:text-accent-foreground"
            >
              {primaryIcon}
            </Button>
          }
        />
        <TooltipPopup side="bottom">{primaryTooltip}</TooltipPopup>
      </Tooltip>

      <GroupSeparator />

      <Menu highlightItemOnHover={false}>
        <MenuTrigger
          render={
            <Button
              size="icon-xs"
              variant="outline"
              aria-label="Switch panel view"
              className="shrink-0"
            />
          }
        >
          <ChevronDownIcon className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem
            disabled={diffDisabled}
            onClick={() => onPanelModeChange(panelMode === "diff" ? null : "diff")}
            className="data-highlighted:bg-transparent data-highlighted:text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
          >
            <DiffIcon className="size-4" />
            <span className="flex-1">Diff</span>
            {panelMode === "diff" && (
              <span className="ml-auto text-xs text-muted-foreground">Active</span>
            )}
          </MenuItem>
          <MenuItem
            disabled={devLogsDisabled}
            onClick={() => onPanelModeChange(panelMode === "dev-logs" ? null : "dev-logs")}
            className="data-highlighted:bg-transparent data-highlighted:text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
          >
            <TerminalIcon className="size-4" />
            <span className="flex-1">Dev logs</span>
            {panelMode === "dev-logs" && (
              <span className="ml-auto text-xs text-muted-foreground">Active</span>
            )}
            {devLogsDisabled && (
              <span className="ml-auto text-xs text-muted-foreground">No server</span>
            )}
          </MenuItem>
        </MenuPopup>
      </Menu>
    </Group>
  );
}
