import React, { useEffect, useState } from "react";
import { ChevronDown, RefreshCw, RotateCcw } from "lucide-react";
import { useI18n } from "../../../../application/i18n/I18nProvider";
import { Button } from "../../../ui/button";
import { cn } from "../../../../lib/utils";
import type { AgentPathInfo } from "./types";
import {
  isCodebuddySessionPersistenceSupported,
  type CodebuddyAdvancedOptions,
} from "../../../../infrastructure/ai/types";
import { parseEnvLines, serializeEnvLines } from "./codebuddyConfigEnv";

const INTERNET_ENV_OPTIONS = [
  { value: "", labelKey: "ai.codebuddy.internetEnv.default" },
  { value: "internal", labelKey: "ai.codebuddy.internetEnv.internal" },
  { value: "ioa", labelKey: "ai.codebuddy.internetEnv.ioa" },
] as const;

const EFFORT_OPTIONS = [
  { value: "", labelKey: "ai.codebuddy.effort.default" },
  { value: "minimal", labelKey: "ai.codebuddy.effort.minimal" },
  { value: "low", labelKey: "ai.codebuddy.effort.low" },
  { value: "medium", labelKey: "ai.codebuddy.effort.medium" },
  { value: "high", labelKey: "ai.codebuddy.effort.high" },
  { value: "xhigh", labelKey: "ai.codebuddy.effort.xhigh" },
  { value: "max", labelKey: "ai.codebuddy.effort.max" },
] as const;

export const CodebuddyCard: React.FC<{
  pathInfo: AgentPathInfo | null;
  isResolvingPath: boolean;
  customPath: string;
  onCustomPathChange: (path: string) => void;
  onRecheckPath: () => void;
  onResetPath: () => void;
  internetEnv: string;
  onInternetEnvChange: (value: string) => void;
  envText: string;
  onEnvTextChange: (value: string) => void;
  advancedOptions?: CodebuddyAdvancedOptions;
  onAdvancedOptionsChange?: (options: CodebuddyAdvancedOptions | undefined) => void;
}> = ({
  pathInfo,
  isResolvingPath,
  customPath,
  onCustomPathChange,
  onRecheckPath,
  onResetPath,
  internetEnv,
  onInternetEnvChange,
  envText,
  onEnvTextChange,
  advancedOptions,
  onAdvancedOptionsChange,
}) => {
  const { t } = useI18n();
  const found = pathInfo?.available;
  const persistSessionSupported = Boolean(
    found && isCodebuddySessionPersistenceSupported(pathInfo?.version),
  );
  // Unsupported/unknown CLIs keep their own default (persistence enabled),
  // even if a stale false value remains in saved settings.
  const persistSessionEnabled = !persistSessionSupported
    || advancedOptions?.persistSession !== false;
  // Collapsed by default; auto-expand when the user already has config so it
  // isn't hidden. Local UI state — not persisted.
  const [configOpen, setConfigOpen] = useState(
    () => Boolean(internetEnv.trim() || envText.trim()),
  );
  const [advancedOpen, setAdvancedOpen] = useState(
    () => Boolean(advancedOptions && Object.keys(advancedOptions).length > 0),
  );

  const updateAdvanced = (patch: Partial<CodebuddyAdvancedOptions>) => {
    if (!onAdvancedOptionsChange) return;
    const next = { ...(advancedOptions || {}), ...patch };
    // Remove undefined/empty values to keep storage clean.
    const cleaned = Object.fromEntries(
      Object.entries(next).filter(([, v]) => v != null && v !== "" && v !== 0),
    ) as CodebuddyAdvancedOptions;
    onAdvancedOptionsChange(Object.keys(cleaned).length > 0 ? cleaned : undefined);
  };

  // The env editor keeps the raw text the user types. Persisting parses it into
  // a record (dropping incomplete lines), so binding the textarea directly to
  // the persisted value would erase a key the moment it's typed before its "=".
  // Only resync from the persisted value when it changes for some reason other
  // than our own parse→serialize round-trip.
  const [envDraft, setEnvDraft] = useState(envText);
  useEffect(() => {
    setEnvDraft((prev) =>
      serializeEnvLines(parseEnvLines(prev)) === envText ? prev : envText,
    );
  }, [envText]);

  const statusText = isResolvingPath
    ? t('ai.codebuddy.detecting')
    : found
      ? t('ai.codebuddy.detected')
      : t('ai.codebuddy.notFound');

  const statusClassName = isResolvingPath
    ? "text-muted-foreground"
    : found
      ? "text-emerald-500"
      : "text-amber-500";

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <p className="min-w-0 text-xs text-muted-foreground leading-5">
          {t('ai.codebuddy.description')}
        </p>
        <div className={cn("text-xs font-medium shrink-0", statusClassName)}>
          {statusText}
        </div>
      </div>

      {found && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">{t('ai.codebuddy.path')}</span>
          <span className="font-mono text-foreground truncate">{pathInfo.path}</span>
          {pathInfo.version && (
            <>
              <span className="text-muted-foreground">|</span>
              <span className="text-muted-foreground">{pathInfo.version}</span>
            </>
          )}
        </div>
      )}

      {!isResolvingPath && (
        <div className="space-y-2">
          {!found && (
            <p className="text-xs text-amber-500">
              {t('ai.codebuddy.notFoundHint')}
            </p>
          )}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={customPath}
              onChange={(e) => onCustomPathChange(e.target.value)}
              placeholder={t('ai.codebuddy.customPathPlaceholder')}
              className="flex-1 h-8 rounded-md border border-input bg-background px-3 text-sm font-mono placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <Button variant="outline" size="sm" onClick={onRecheckPath} disabled={!customPath.trim()}>
              <RefreshCw size={14} className="mr-1.5" />
              {t('ai.codebuddy.check')}
            </Button>
            <Button variant="ghost" size="sm" onClick={onResetPath} disabled={!customPath.trim()}>
              <RotateCcw size={14} className="mr-1.5" />
              {t('ai.codebuddy.resetPath')}
            </Button>
          </div>
        </div>
      )}

      {/* Authentication & config (optional, collapsible) */}
      <div className="border-t border-border/60 pt-3">
        <button
          type="button"
          onClick={() => setConfigOpen((v) => !v)}
          aria-expanded={configOpen}
          className="flex w-full items-center justify-between gap-2 text-left"
        >
          <span className="text-xs font-medium text-muted-foreground">
            {t('ai.codebuddy.configSection')}
          </span>
          <ChevronDown
            size={14}
            className={cn("text-muted-foreground transition-transform", configOpen && "rotate-180")}
          />
        </button>
        {configOpen && (
          <div className="space-y-3 mt-3">
            <div className="space-y-1.5">
              <label htmlFor="codebuddy-internet-env" className="text-xs text-muted-foreground">{t('ai.codebuddy.internetEnv')}</label>
              <select
                id="codebuddy-internet-env"
                value={internetEnv}
                onChange={(e) => onInternetEnvChange(e.target.value)}
                className="w-full h-8 rounded-md border border-input bg-background px-3 text-sm font-mono focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {INTERNET_ENV_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{t(opt.labelKey)}</option>
                ))}
              </select>
              <p className="text-[11px] text-muted-foreground leading-4">{t('ai.codebuddy.internetEnv.hint')}</p>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="codebuddy-env-vars" className="text-xs text-muted-foreground">{t('ai.codebuddy.envVars')}</label>
              <textarea
                id="codebuddy-env-vars"
                value={envDraft}
                onChange={(e) => { setEnvDraft(e.target.value); onEnvTextChange(e.target.value); }}
                placeholder={t('ai.codebuddy.envVars.placeholder')}
                rows={3}
                spellCheck={false}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y"
              />
              <p className="text-[11px] text-muted-foreground leading-4">{t('ai.codebuddy.envVars.hint')}</p>
            </div>
          </div>
        )}
      </div>

      {/* Advanced SDK options (SDK 0.3.258) */}
      {onAdvancedOptionsChange && (
        <div className="border-t border-border/60 pt-3">
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            aria-expanded={advancedOpen}
            className="flex w-full items-center justify-between gap-2 text-left"
          >
            <span className="text-xs font-medium text-muted-foreground">
              {t('ai.codebuddy.advancedSection')}
            </span>
            <ChevronDown
              size={14}
              className={cn("text-muted-foreground transition-transform", advancedOpen && "rotate-180")}
            />
          </button>
          {advancedOpen && (
            <div className="space-y-3 mt-3">
              {/* Effort */}
              <div className="space-y-1.5">
                <label htmlFor="codebuddy-effort" className="text-xs text-muted-foreground">{t('ai.codebuddy.effort')}</label>
                <select
                  id="codebuddy-effort"
                  value={advancedOptions?.effort || ""}
                  onChange={(e) => updateAdvanced({ effort: (e.target.value || undefined) as CodebuddyAdvancedOptions['effort'] })}
                  className="w-full h-8 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {EFFORT_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{t(opt.labelKey)}</option>
                  ))}
                </select>
                <p className="text-[11px] text-muted-foreground leading-4">{t('ai.codebuddy.effort.hint')}</p>
              </div>
              {/* Max Turns */}
              <div className="space-y-1.5">
                <label htmlFor="codebuddy-max-turns" className="text-xs text-muted-foreground">{t('ai.codebuddy.maxTurns')}</label>
                <input
                  id="codebuddy-max-turns"
                  type="number"
                  min={1}
                  max={200}
                  value={advancedOptions?.maxTurns ?? ""}
                  onChange={(e) => updateAdvanced({ maxTurns: e.target.value ? Number(e.target.value) : undefined })}
                  placeholder="20"
                  className="w-full h-8 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
                <p className="text-[11px] text-muted-foreground leading-4">{t('ai.codebuddy.maxTurns.hint')}</p>
              </div>
              {/* Max Budget USD */}
              <div className="space-y-1.5">
                <label htmlFor="codebuddy-max-budget" className="text-xs text-muted-foreground">{t('ai.codebuddy.maxBudget')}</label>
                <input
                  id="codebuddy-max-budget"
                  type="number"
                  min={0.01}
                  step={0.01}
                  value={advancedOptions?.maxBudgetUsd ?? ""}
                  onChange={(e) => updateAdvanced({ maxBudgetUsd: e.target.value ? Number(e.target.value) : undefined })}
                  placeholder="0.50"
                  className="w-full h-8 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
                <p className="text-[11px] text-muted-foreground leading-4">{t('ai.codebuddy.maxBudget.hint')}</p>
              </div>
              {/* Sandbox */}
              <div className="flex items-center justify-between gap-2">
                <div>
                  <span className="text-xs text-muted-foreground">{t('ai.codebuddy.sandbox')}</span>
                  <p className="text-[11px] text-muted-foreground leading-4">{t('ai.codebuddy.sandbox.hint')}</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={Boolean(advancedOptions?.sandbox?.enabled)}
                  onClick={() => updateAdvanced({ sandbox: advancedOptions?.sandbox?.enabled ? undefined : { enabled: true } })}
                  className={cn(
                    "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors",
                    advancedOptions?.sandbox?.enabled ? "bg-primary" : "bg-muted",
                  )}
                >
                  <span className={cn(
                    "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
                    advancedOptions?.sandbox?.enabled ? "translate-x-[18px]" : "translate-x-[3px]",
                  )} />
                </button>
              </div>
              {/* Session Persistence */}
              <div className="flex items-center justify-between gap-2">
                <div>
                  <span className="text-xs text-muted-foreground">{t('ai.codebuddy.persistSession')}</span>
                  <p className="text-[11px] text-muted-foreground leading-4">{t('ai.codebuddy.persistSession.hint')}</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  disabled={!persistSessionSupported}
                  aria-checked={persistSessionEnabled}
                  onClick={() => {
                    if (!persistSessionSupported) return;
                    updateAdvanced({ persistSession: advancedOptions?.persistSession === false ? undefined : false });
                  }}
                  className={cn(
                    "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors",
                    !persistSessionSupported && "cursor-not-allowed opacity-50",
                    persistSessionEnabled ? "bg-primary" : "bg-muted",
                  )}
                >
                  <span className={cn(
                    "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
                    persistSessionEnabled ? "translate-x-[18px]" : "translate-x-[3px]",
                  )} />
                </button>
              </div>
              {/* File Checkpointing */}
              <div className="flex items-center justify-between gap-2">
                <div>
                  <span className="text-xs text-muted-foreground">{t('ai.codebuddy.fileCheckpointing')}</span>
                  <p className="text-[11px] text-muted-foreground leading-4">{t('ai.codebuddy.fileCheckpointing.hint')}</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={Boolean(advancedOptions?.enableFileCheckpointing)}
                  onClick={() => updateAdvanced({ enableFileCheckpointing: advancedOptions?.enableFileCheckpointing ? undefined : true })}
                  className={cn(
                    "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors",
                    advancedOptions?.enableFileCheckpointing ? "bg-primary" : "bg-muted",
                  )}
                >
                  <span className={cn(
                    "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
                    advancedOptions?.enableFileCheckpointing ? "translate-x-[18px]" : "translate-x-[3px]",
                  )} />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
