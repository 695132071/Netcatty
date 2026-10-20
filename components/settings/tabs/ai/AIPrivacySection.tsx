import React, { useEffect, useState } from "react";
import { useI18n } from "../../../../application/i18n/I18nProvider";
import { useAIPrivacyState } from "../../../../application/state/useExternalMcpToggleState";
import { Button } from "../../../ui/button";
import { SettingCard, SettingRow, SettingsSection, Toggle } from "../../settings-ui";

export const AIPrivacySection: React.FC = () => {
  const { t } = useI18n();
  const { settings, error, applying, apply } = useAIPrivacyState();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [privateIps, setPrivateIps] = useState(settings.redactPrivateIps);
  const [cidrs, setCidrs] = useState(settings.cidrs.join("\n"));
  const [patterns, setPatterns] = useState(settings.patterns.join("\n"));
  const [applied, setApplied] = useState(false);

  useEffect(() => {
    setEnabled(settings.enabled);
    setPrivateIps(settings.redactPrivateIps);
    setCidrs(settings.cidrs.join("\n"));
    setPatterns(settings.patterns.join("\n"));
  }, [settings]);

  const onApply = async () => {
    setApplied(false);
    const saved = await apply({
      enabled,
      redactPrivateIps: privateIps,
      cidrs: cidrs.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      patterns: patterns.split(/\r?\n/).filter((line) => line.trim().length > 0),
    });
    setApplied(saved);
  };

  return (
    <SettingsSection anchorId="ai-privacy" title={t("ai.privacy.title")}>
      <p className="text-xs text-muted-foreground leading-5">{t("ai.privacy.description")}</p>
      <p className="text-xs text-muted-foreground leading-5">{t("ai.privacy.boundary")}</p>
      <SettingCard divided className="rounded-md border-border/60 bg-background/70">
        <SettingRow label={t("ai.privacy.enable")}>
          <Toggle
            checked={enabled}
            onChange={(next) => { setEnabled(next); setApplied(false); }}
            ariaLabel={t("ai.privacy.enable")}
            disabled={applying}
          />
        </SettingRow>
        <SettingRow
          label={t("ai.privacy.privateIps")}
          description={t("ai.privacy.privateIps.description")}
        >
          <Toggle
            checked={privateIps}
            onChange={(next) => { setPrivateIps(next); setApplied(false); }}
            ariaLabel={t("ai.privacy.privateIps")}
            disabled={applying}
          />
        </SettingRow>
      </SettingCard>
      <div className="space-y-3 rounded-md border border-border/60 bg-background/50 p-3">
        <label className="block space-y-1.5">
          <span className="text-xs font-medium">{t("ai.privacy.cidrs")}</span>
          <span className="block text-xs text-muted-foreground">{t("ai.privacy.cidrs.description")}</span>
          <textarea
            value={cidrs}
            onChange={(event) => { setCidrs(event.currentTarget.value); setApplied(false); }}
            aria-label={t("ai.privacy.cidrs")}
            placeholder={"192.0.2.0/24\n2001:db8::/32"}
            rows={3}
            spellCheck={false}
            disabled={applying}
            className="w-full resize-y rounded-md border border-border/60 bg-background px-2 py-1.5 font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium">{t("ai.privacy.patterns")}</span>
          <span className="block text-xs text-muted-foreground">{t("ai.privacy.patterns.description")}</span>
          <textarea
            value={patterns}
            onChange={(event) => { setPatterns(event.currentTarget.value); setApplied(false); }}
            aria-label={t("ai.privacy.patterns")}
            placeholder="INTERNAL_[A-Z0-9]+"
            rows={3}
            spellCheck={false}
            disabled={applying}
            className="w-full resize-y rounded-md border border-border/60 bg-background px-2 py-1.5 font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </label>
        <p className="text-xs text-muted-foreground leading-5">{t("ai.privacy.connectionScope")}</p>
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-amber-500">{t("ai.privacy.reconnect")}</p>
          <Button size="sm" variant="outline" onClick={() => { void onApply(); }} disabled={applying}>
            {t(applying ? "ai.privacy.applying" : "ai.privacy.apply")}
          </Button>
        </div>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {t("ai.privacy.failed")} {error}
          </p>
        ) : applied ? (
          <p role="status" className="text-xs text-emerald-500">{t("ai.privacy.applied")}</p>
        ) : null}
      </div>
    </SettingsSection>
  );
};
