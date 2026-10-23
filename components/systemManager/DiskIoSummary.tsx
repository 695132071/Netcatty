import React from "react";
import { useI18n } from "../../application/i18n/I18nProvider";

function rate(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value < 0) return "--";
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB/s`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB/s`;
  return `${Math.round(value)} B/s`;
}

/** Same shared-sampler rates in monitor cards, tables, and terminal overview. */
export function DiskIoSummary({ stats }: {
  stats?: { diskReadSpeed?: number | null; diskWriteSpeed?: number | null } | null;
}) {
  const { t } = useI18n();
  return (
    <div data-disk-io className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] tabular-nums text-muted-foreground" title={t("monitor.diskIoHint")}>
      <span>{t("monitor.diskIo")}</span>
      <span>{t("monitor.diskRead")} {rate(stats?.diskReadSpeed)}</span>
      <span>{t("monitor.diskWrite")} {rate(stats?.diskWriteSpeed)}</span>
    </div>
  );
}
