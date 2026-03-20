import { DiffIcon, TerminalIcon } from "lucide-react";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export type RightPanelMode = "diff" | "dev-logs";

interface DiffPanelButtonProps {
  active: boolean;
  isGitRepo: boolean;
  shortcutLabel: string | null;
  onToggle: () => void;
}

export function DiffPanelButton({
  active,
  isGitRepo,
  shortcutLabel,
  onToggle,
}: DiffPanelButtonProps) {
  const tooltip = (() => {
    if (active) {
      return shortcutLabel ? `Hide diff panel (${shortcutLabel})` : "Hide diff panel";
    }
    if (isGitRepo) {
      return shortcutLabel ? `Show diff panel (${shortcutLabel})` : "Show diff panel";
    }
    return "Diff unavailable (no git repo)";
  })();

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="outline"
            onClick={onToggle}
            disabled={!isGitRepo}
            aria-pressed={active}
            aria-label={active ? "Hide diff panel" : "Show diff panel"}
            data-state={active ? "on" : "off"}
            className="shrink-0 data-[state=on]:bg-accent data-[state=on]:text-accent-foreground"
          >
            <DiffIcon className="size-3" />
          </Button>
        }
      />
      <TooltipPopup side="bottom">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

interface DevLogsPanelButtonProps {
  active: boolean;
  onToggle: () => void;
}

export function DevLogsPanelButton({ active, onToggle }: DevLogsPanelButtonProps) {
  const tooltip = active ? "Hide dev logs panel" : "Show dev logs panel";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="outline"
            onClick={onToggle}
            aria-pressed={active}
            aria-label={active ? "Hide dev logs panel" : "Show dev logs panel"}
            data-state={active ? "on" : "off"}
            className="shrink-0 data-[state=on]:bg-accent data-[state=on]:text-accent-foreground"
          >
            <TerminalIcon className="size-3" />
          </Button>
        }
      />
      <TooltipPopup side="bottom">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
