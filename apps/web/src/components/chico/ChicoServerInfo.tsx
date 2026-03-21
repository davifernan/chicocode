/**
 * ChicoServerInfo — displays the gRPC endpoint the user needs to set
 * on Chico containers so they connect to T3code as Cloud Controller.
 */

import { CopyIcon, CheckIcon, ServerIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/utils";
import type { ChicoServerInfo as ServerInfo } from "@t3tools/contracts";

interface Props {
  info: ServerInfo;
  className?: string;
}

export function ChicoServerInfo({ info, className }: Props) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard.writeText(`CHICO_GRPC_ENDPOINT=${info.endpoint}`).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };

  return (
    <button
      onClick={handleCopy}
      title="Copy CHICO_GRPC_ENDPOINT"
      className={cn(
        "group flex items-center gap-2 rounded-md border border-border",
        "bg-muted/50 px-3 py-1.5 text-xs font-mono text-muted-foreground",
        "hover:bg-muted hover:text-foreground transition-colors cursor-pointer select-all",
        className,
      )}
    >
      <ServerIcon className="size-3 shrink-0 text-primary/70" />
      <span className="truncate">
        <span className="text-muted-foreground/60">CHICO_GRPC_ENDPOINT=</span>
        <span className="text-foreground">{info.endpoint}</span>
      </span>
      {copied ? (
        <CheckIcon className="size-3 shrink-0 text-green-500" />
      ) : (
        <CopyIcon className="size-3 shrink-0 opacity-0 group-hover:opacity-60 transition-opacity" />
      )}
    </button>
  );
}
