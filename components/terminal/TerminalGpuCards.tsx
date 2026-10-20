import React from "react";

import { useI18n } from "../../application/i18n/I18nProvider";
import type { GpuDeviceStats } from "../../application/state/useServerStats";
import { cn } from "../../lib/utils";

export function formatGpuMemoryGib(usedMb: number | null, totalMb: number | null): string | null {
  if (usedMb === null || totalMb === null || !(totalMb > 0)) return null;
  return `${(usedMb / 1024).toFixed(1)}/${(totalMb / 1024).toFixed(1)}G`;
}

function usageBarClass(usage: number): string {
  return usage >= 90 ? "bg-red-500" : usage >= 70 ? "bg-amber-500" : "bg-emerald-500";
}

function usageTextClass(usage: number): string {
  return usage >= 90 ? "text-red-400" : usage >= 70 ? "text-amber-400" : "text-emerald-400";
}

interface TerminalGpuCardsProps {
  gpus: GpuDeviceStats[];
  gpu: number;
  gpuName: string | null;
  gpuMemUsed: number | null;
  gpuMemTotal: number | null;
}

/**
 * Per-GPU details for the terminal stats hover card.
 * Mirrors the CPU per-core grid: four columns, the same bar heights,
 * threshold colors, and a scroll cap so many cards stay inside the popover.
 */
export const TerminalGpuCards: React.FC<TerminalGpuCardsProps> = ({
  gpus,
  gpu,
  gpuName,
  gpuMemUsed,
  gpuMemTotal,
}) => {
  const { t } = useI18n();
  const aggregateMemory = formatGpuMemoryGib(gpuMemUsed, gpuMemTotal);

  const columns = Math.min(4, gpus.length);

  return (
    <div className={cn("text-xs space-y-2 w-max max-w-[26rem]", gpus.length === 1 && "min-w-[160px]")}>
      <div className="font-medium text-sm mb-2">{t("terminal.serverStats.gpuDevices")}</div>
      {gpus.length > 0 ? (
        <div
          className="grid gap-1.5 max-h-[260px] overflow-y-auto pr-1 overscroll-contain"
          style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}
        >
          {gpus.map((device) => {
            const usage = device.utilization;
            const memory = formatGpuMemoryGib(device.memoryUsed, device.memoryTotal);
            return (
              <div key={device.index} className="flex w-full min-w-0 flex-col items-center gap-1">
                <div className="text-[10px] text-muted-foreground">
                  {t("terminal.serverStats.gpuIndex", { index: device.index })}
                </div>
                {device.name ? (
                  <div
                    className="line-clamp-2 w-full break-words text-center text-[10px] leading-tight text-muted-foreground"
                    title={device.name}
                  >
                    {device.name}
                  </div>
                ) : null}
                <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className={cn(
                      "h-full rounded-full transition-all",
                      usage === null ? "bg-muted" : usageBarClass(usage),
                    )}
                    style={{ width: `${usage ?? 0}%` }}
                  />
                </div>
                <div className={cn(
                  "text-[11px] font-medium",
                  usage === null ? "text-muted-foreground" : usageTextClass(usage),
                )}>
                  {usage === null ? "--" : `${usage}%`}
                </div>
                {memory ? (
                  <div className="text-[10px] text-muted-foreground whitespace-nowrap">{memory}</div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 min-w-[160px]">
          {gpuName ? (
            <div className="text-[10px] text-muted-foreground truncate" title={gpuName}>{gpuName}</div>
          ) : null}
          <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
            <div
              className={cn("h-full rounded-full transition-all", usageBarClass(gpu))}
              style={{ width: `${gpu}%` }}
            />
          </div>
          <div className={cn("text-center text-[11px] font-medium", usageTextClass(gpu))}>
            {gpu}%{aggregateMemory ? ` · ${aggregateMemory}` : ""}
          </div>
        </div>
      )}
    </div>
  );
};
