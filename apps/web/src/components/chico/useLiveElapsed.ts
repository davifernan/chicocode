import { useEffect, useState } from "react";

/**
 * Returns the elapsed milliseconds since `startTime` and updates every second.
 *
 * Without a timer, elapsed time would only update when a parent re-renders
 * (e.g. on a new event from the store). During idle periods this caused the
 * displayed duration to freeze. This hook ticks independently of event flow.
 *
 * @param startTime - ISO 8601 timestamp string, or null/undefined if not started.
 * @returns Elapsed milliseconds, or 0 if startTime is null/undefined.
 */
export function useLiveElapsed(startTime: string | null | undefined): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!startTime) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [startTime]);

  if (!startTime) return 0;
  return now - new Date(startTime).getTime();
}
