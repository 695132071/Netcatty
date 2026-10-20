import React from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "../../../../lib/utils";
import { Button } from "../../../ui/button";

type CopyableCodeBlockProps = {
  label?: string;
  value: string;
  copyKey: string;
  copied: string | null;
  onCopy: (key: string, text: string) => void;
  copyLabel: string;
  copiedLabel: string;
  emptyLabel?: string;
  className?: string;
};

export const CopyableCodeBlock: React.FC<CopyableCodeBlockProps> = ({
  label,
  value,
  copyKey,
  copied,
  onCopy,
  copyLabel,
  copiedLabel,
  emptyLabel,
  className,
}) => {
  const display = value || emptyLabel || "";
  const canCopy = Boolean(value);
  const isCopied = copied === copyKey;

  return (
    <div className={cn("space-y-1.5", className)}>
      {label ? (
        <div className="text-xs font-medium text-muted-foreground">{label}</div>
      ) : null}
      <div className="group relative rounded-md border border-border/60 bg-muted/20">
        <pre
          className={cn(
            "max-h-40 overflow-auto whitespace-pre-wrap break-all px-3 py-2.5 pr-11 font-mono text-xs leading-5",
            !value && "text-muted-foreground",
          )}
        >
          {display}
        </pre>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!canCopy}
          className="absolute right-1.5 top-1.5 h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
          onClick={() => void onCopy(copyKey, value)}
          aria-label={isCopied ? copiedLabel : copyLabel}
          title={isCopied ? copiedLabel : copyLabel}
        >
          {isCopied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
        </Button>
      </div>
    </div>
  );
};
