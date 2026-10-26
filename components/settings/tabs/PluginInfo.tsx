import React, { useRef, useState } from 'react';
import { Info } from 'lucide-react';
import { Button } from '../../ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../ui/tooltip';

/** Hover/focus previews explanatory text; click pins it in the existing accessible popover. */
export function PluginInfo({ label, children, text, previewContent }: { label: string; children: React.ReactNode; text?: string; previewContent?: React.ReactNode }) {
  const [pinned, setPinned] = useState(false);
  const [preview, setPreview] = useState(false);
  const suppressFocusPreview = useRef(false);
  return <Popover open={pinned} onOpenChange={(open) => { setPinned(open); setPreview(false); }}>
    <TooltipProvider delayDuration={200}>
      <Tooltip open={!pinned && preview} onOpenChange={(open) => { if (!open || !suppressFocusPreview.current) setPreview(open); }}>
        <TooltipTrigger asChild><PopoverTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className={`h-8 shrink-0 text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring ${text ? 'gap-1.5 px-2' : 'w-8 p-0'}`} aria-label={label} onBlur={() => { suppressFocusPreview.current = false; }} onPointerMove={() => { suppressFocusPreview.current = false; }}>
            <Info size={15} />{text && <span className="text-xs">{text}</span>}
          </Button>
        </PopoverTrigger></TooltipTrigger>
        <TooltipContent className="max-w-xs space-y-2 bg-popover p-3 text-xs leading-5 text-popover-foreground shadow-sm">{previewContent ?? children}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
    <PopoverContent onEscapeKeyDown={() => { suppressFocusPreview.current = true; }} aria-label={label} align="end" className="max-w-xs space-y-2 text-xs leading-5">{children}</PopoverContent>
  </Popover>;
}
