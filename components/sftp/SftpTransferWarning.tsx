import { AlertTriangle } from "lucide-react";
import React from "react";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

/** Cleanup warnings are not transfer errors: retain the completed lifecycle. */
export function SftpTransferWarning({ warning, compact = false }: { warning?: string; compact?: boolean }) {
  if (!warning) return null;
  const content = (
    <span className={cn("flex min-w-0 items-start gap-1 text-[10px] text-amber-600 dark:text-amber-400", !compact && "select-text")} data-section="sftp-transfer-warning">
      <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span className={compact ? "truncate" : "break-all"}>{warning}</span>
    </span>
  );
  return compact ? (
    <Tooltip>
      <TooltipTrigger asChild><span className="block min-w-0" tabIndex={0}>{content}</span></TooltipTrigger>
      <TooltipContent className="max-w-md select-text break-all">{warning}</TooltipContent>
    </Tooltip>
  ) : content;
}
