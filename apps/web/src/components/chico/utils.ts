/**
 * Shared formatting utilities for Chico UI components.
 */

/** Format elapsed milliseconds as "Xm Ys" or "Xh Ym". */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
}

/** Lifecycle → display icon character */
export function lifecycleIcon(lifecycle: string): string {
  switch (lifecycle) {
    case "running":
      return "●";
    case "idle":
      return "◌";
    case "declared":
      return "○";
    case "starting":
      return "◎";
    case "completed":
      return "✓";
    case "failed":
      return "✗";
    case "aborted":
      return "⊘";
    case "stopped":
      return "□";
    default:
      return "?";
  }
}

/** Lifecycle → Tailwind text color class */
export function lifecycleColor(lifecycle: string): string {
  switch (lifecycle) {
    case "running":
      return "text-primary";
    case "idle":
      return "text-yellow-500";
    case "declared":
      return "text-muted-foreground/50";
    case "starting":
      return "text-blue-400";
    case "completed":
      return "text-green-500";
    case "failed":
      return "text-destructive";
    case "aborted":
      return "text-orange-400";
    case "stopped":
      return "text-muted-foreground";
    default:
      return "text-muted-foreground";
  }
}

/** Event level → Tailwind text color class */
export function eventLevelColor(level: string): string {
  switch (level.toLowerCase()) {
    case "error":
      return "text-destructive";
    case "warn":
    case "warning":
      return "text-yellow-500";
    case "info":
      return "text-muted-foreground";
    case "debug":
      return "text-muted-foreground/50";
    default:
      return "text-muted-foreground";
  }
}
