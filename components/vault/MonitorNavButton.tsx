import React from "react";
import { Gauge } from "lucide-react";
import { useI18n } from "../../application/i18n/I18nProvider";
import { useMonitorSnapshot } from "../../application/state/monitorRuntimeStore";
import { cn } from "../../lib/utils";
import { RippleButton } from "../ui/ripple";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
export function MonitorNavButton({
  active,
  collapsed,
  onClick,
}: {
  active: boolean;
  collapsed: boolean;
  onClick: () => void;
}) {
  const { t } = useI18n();
  const { count } = useMonitorSnapshot();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <RippleButton
          variant={active ? "secondary" : "ghost"}
          onClick={onClick}
          className={cn(
            "w-full h-10",
            collapsed ? "justify-center p-0" : "justify-start gap-3",
            active &&
              "bg-foreground/10 text-foreground hover:bg-foreground/15 border-border/40",
          )}
        >
          <Gauge size={16} className="shrink-0" />
          {!collapsed && (
            <>
              <span>{t("monitor.title")}</span>
              {count > 0 && (
                <span className="ml-auto text-xs text-primary tabular-nums">
                  {count}
                </span>
              )}
            </>
          )}
          {collapsed && count > 0 && (
            <span className="text-[10px] text-primary">{count}</span>
          )}
        </RippleButton>
      </TooltipTrigger>
      <TooltipContent side="right">{t("monitor.title")}</TooltipContent>
    </Tooltip>
  );
}
