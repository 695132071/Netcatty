import React, { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Copy,
  LayoutGrid,
  List,
  Pencil,
  Play,
  Plus,
  Square,
  Terminal,
  Trash2,
} from "lucide-react";
import { useI18n } from "../../application/i18n/I18nProvider";
import {
  deleteMonitorPanel,
  saveMonitorPanel,
  useMonitorPanels,
} from "../../application/state/monitorPanelsStorage";
import {
  monitorActions,
  useMonitorSnapshot,
} from "../../application/state/monitorRuntimeStore";
import type { MonitorPanel } from "../../domain/monitorPanels";
import {
  monitorNeedsAttention,
  type MonitorHostState,
  type MonitorPoint,
} from "../../domain/monitorRuntime";
import type { Host } from "../../domain/models";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { Badge } from "../ui/badge";
import { Combobox } from "../ui/combobox";
import { ScrollArea } from "../ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import {
  AsideActionMenu,
  AsideActionMenuItem,
  AsidePanel,
  AsidePanelContent,
  AsidePanelFooter,
} from "../ui/aside-panel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import SelectHostPanel from "../SelectHostPanel";
import { VaultHeaderSearch, VaultPageHeader } from "./VaultPageHeader";
import { toast } from "../ui/toast";

const percent = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "--" : `${n.toFixed(1)}%`;
const capacity = (n: number | null | undefined) =>
  n == null
    ? "--"
    : n >= 1024
      ? `${(n / 1024).toFixed(1)} GiB`
      : `${n.toFixed(0)} MiB`;
const rate = (n: number | null | undefined) =>
  n == null
    ? "--"
    : n >= 1048576
      ? `${(n / 1048576).toFixed(1)} MiB/s`
      : `${(n / 1024).toFixed(1)} KiB/s`;

/** Sparse lines: never bridge a missing sample or invent history before monitoring started. */
export function MonitorTrend({
  points,
  field,
  range,
  interval,
  label,
  className,
}: {
  points: MonitorPoint[];
  field: "cpu" | "memory" | "rx" | "tx";
  range: number;
  interval: number;
  label: string;
  className?: string;
}) {
  const end = Date.now(),
    start = end - range * 60000;
  const visible = points.filter((p) => p.at >= start);
  const max =
    field === "cpu" || field === "memory"
      ? 100
      : Math.max(1, ...visible.map((p) => p[field] ?? 0));
  const segments: string[] = [];
  let current = "";
  let previous: MonitorPoint | null = null;
  for (const p of visible) {
    const value = p[field];
    if (value == null) {
      if (current) segments.push(current);
      current = "";
      previous = null;
      continue;
    }
    if (previous && p.at - previous.at > interval * 2500) {
      if (current) segments.push(current);
      current = "";
    }
    const x = Math.max(
      0,
      Math.min(300, ((p.at - start) / (end - start)) * 300),
    );
    const y = 58 - (Math.min(max, Math.max(0, value)) / max) * 54;
    current += `${current ? " L" : "M"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    previous = p;
  }
  if (current) segments.push(current);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox="0 0 300 64"
      preserveAspectRatio="none"
      className={cn("h-16 w-full text-primary", className)}
    >
      <path d="M0 58 H300" className="stroke-border" strokeWidth=".5" />
      {segments.map((d, i) => (
        <path
          key={i}
          d={d}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

export function MonitorRunningIndicator() {
  const { t } = useI18n();
  const { count } = useMonitorSnapshot();
  if (!count) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-8 gap-1.5 app-no-drag text-xs"
      onClick={monitorActions.stopAll}
      title={t("monitor.stopAll")}
    >
      <Activity size={14} className="text-primary" />
      <span>{t("monitor.runningCount", { count })}</span>
      <Square size={11} />
    </Button>
  );
}

export function MonitorPanels({
  hosts,
  customGroups,
  onConnect,
}: {
  hosts: Host[];
  customGroups: string[];
  onConnect: (host: Host) => void;
}) {
  const { t } = useI18n();
  const panels = useMonitorPanels();
  const runtime = useMonitorSnapshot();
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [editor, setEditor] = useState<{
    base: MonitorPanel | null;
    draft: MonitorPanel;
  } | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<MonitorPanel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [login, setLogin] = useState({
    hostId: "",
    username: "",
    password: "",
  });
  useEffect(
    () => setLogin({ hostId: "", username: "", password: "" }),
    [detail],
  );
  const panel = panels.find((p) => p.id === selected) ?? panels[0];
  const running = !!panel && runtime.running.includes(panel.id);
  const startEdit = (base: MonitorPanel | null) => {
    setDetail(null);
    setSelecting(false);
    setError(null);
    setEditor({
      base,
      draft: base
        ? { ...base, hostIds: [...base.hostIds] }
        : {
            id: crypto.randomUUID(),
            name: "",
            description: "",
            hostIds: [],
            view: "charts",
            interval: 10,
            range: 15,
            sort: "manual",
            attentionOnly: false,
          },
    });
  };
  const updateDraft = (patch: Partial<MonitorPanel>) =>
    setEditor((prev) =>
      prev ? { ...prev, draft: { ...prev.draft, ...patch } } : prev,
    );
  const save = async () => {
    if (!editor) return;
    if (!editor.draft.name.trim()) {
      setError("monitor.nameRequired");
      return;
    }
    if (!editor.draft.hostIds.length) {
      setError("monitor.hostRequired");
      return;
    }
    setSaving(true);
    try {
      await saveMonitorPanel(editor.base, editor.draft);
      setSelected(editor.draft.id);
      setEditor(null);
    } catch (e) {
      setError(
        e instanceof Error && e.message.startsWith("monitor.")
          ? e.message
          : "monitor.saveFailed",
      );
    } finally {
      setSaving(false);
    }
  };
  const patchPanel = async (patch: Partial<MonitorPanel>) => {
    if (!panel) return;
    try {
      await saveMonitorPanel(panel, { ...panel, ...patch });
    } catch {
      toast.error(t("monitor.saveFailed"));
    }
  };
  const duplicate = async () => {
    if (!panel) return;
    let name = t("monitor.copyName", { name: panel.name });
    let suffix = 2;
    while (
      panels.some(
        (p) => p.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
      )
    )
      name = `${t("monitor.copyName", { name: panel.name })} ${suffix++}`;
    const copy = { ...panel, id: crypto.randomUUID(), name };
    try {
      await saveMonitorPanel(null, copy);
      setSelected(copy.id);
      setDetail(null);
      setEditor(null);
    } catch {
      toast.error(t("monitor.saveFailed"));
    }
  };
  const rows = useMemo(() => {
    if (!panel) return [];
    const q = search.trim().toLocaleLowerCase();
    const rows = panel.hostIds.map((id) => ({
      id,
      host: hosts.find((h) => h.id === id),
      state: runtime.hosts[id],
    }));
    const filtered = rows.filter(
      ({ host, state }) =>
        (!q ||
          `${host?.label ?? ""} ${host?.hostname ?? ""} ${host?.group ?? ""}`
            .toLocaleLowerCase()
            .includes(q)) &&
        (!panel.attentionOnly ||
          !host ||
          monitorNeedsAttention(state, panel.interval)),
    );
    return panel.sort === "manual"
      ? filtered
      : filtered.sort((a, b) => {
          if (panel.sort === "name")
            return (a.host?.label ?? a.id).localeCompare(b.host?.label ?? b.id);
          const score = (state: MonitorHostState | undefined) =>
            panel.sort === "cpu"
              ? state?.stats?.cpu
              : panel.sort === "memory"
                ? state?.stats?.memTotal && state.stats.memUsed != null
                  ? (state.stats.memUsed / state.stats.memTotal) * 100
                  : null
                : state?.stats?.diskPercent;
          return (score(b.state) ?? -1) - (score(a.state) ?? -1);
        });
  }, [panel, hosts, runtime, search]);
  const status = (host: Host | undefined, state?: MonitorHostState) =>
    !host
      ? "missing"
      : !running
        ? "stopped"
        : state?.status === "live" &&
            Date.now() - state.at > (panel?.interval ?? 10) * 2500
          ? "stale"
          : (state?.status ?? "queued");
  const stateBadge = (host: Host | undefined, state?: MonitorHostState) => (
    <Badge
      variant="outline"
      className={cn(
        "text-[10px] shrink-0",
        ["live"].includes(status(host, state))
          ? "text-primary border-primary/30"
          : "text-muted-foreground",
      )}
    >
      {t(`monitor.status.${status(host, state)}`)}
    </Badge>
  );
  const renderMetrics = (
    state: MonitorHostState | undefined,
    large = false,
  ) => {
    const s = state?.stats;
    const memory =
      s?.memTotal && s.memUsed != null ? (s.memUsed / s.memTotal) * 100 : null;
    return (
      <div className={cn("grid grid-cols-2 gap-3", large && "gap-5")}>
        <div>
          <div className="text-xs text-muted-foreground">
            {t("monitor.cpu")}
          </div>
          <div className="text-lg tabular-nums">
            {percent(s?.cpu)}{" "}
            <span className="text-xs text-muted-foreground">
              {s?.cpuCores ? t("monitor.cores", { count: s.cpuCores }) : ""}
            </span>
          </div>
          {panel && (
            <MonitorTrend
              points={state?.points ?? []}
              field="cpu"
              range={panel.range}
              interval={panel.interval}
              label={t("monitor.cpuTrend")}
            />
          )}
        </div>
        <div>
          <div className="text-xs text-muted-foreground">
            {t("monitor.memory")}
          </div>
          <div className="text-lg tabular-nums">{percent(memory)}</div>
          <div className="text-[10px] text-muted-foreground">
            {capacity(s?.memUsed)} / {capacity(s?.memTotal)}
          </div>
          {panel && (
            <MonitorTrend
              points={state?.points ?? []}
              field="memory"
              range={panel.range}
              interval={panel.interval}
              label={t("monitor.memoryTrend")}
            />
          )}
        </div>
      </div>
    );
  };
  const hostDetail = hosts.find((h) => h.id === detail);
  const detailState = detail ? runtime.hosts[detail] : undefined;
  const hasAside = !!editor || !!detail;
  return (
    <section
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
      data-section="vault-monitor"
    >
      <VaultPageHeader>
        <Activity size={18} />
        <h1 className="font-semibold text-sm">{t("monitor.title")}</h1>
        <div className="flex-1" />
        {!!runtime.count && (
          <>
            <span className="hidden lg:block text-xs text-muted-foreground">
              {t("monitor.runningSummary", {
                count: runtime.count,
                hosts: runtime.hostCount,
              })}
            </span>
            <Button variant="ghost" size="sm" onClick={monitorActions.stopAll}>
              {t("monitor.stopAll")}
            </Button>
          </>
        )}
        <Button size="sm" className="gap-1.5" onClick={() => startEdit(null)}>
          <Plus size={14} />
          {t("monitor.create")}
        </Button>
      </VaultPageHeader>
      {runtime.unavailable && (
        <p
          role="alert"
          className="border-b border-border/40 px-4 py-3 text-xs text-destructive"
        >
          {t("monitor.unavailable")}
        </p>
      )}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          className={cn(
            "flex min-w-0 flex-1 flex-col",
            hasAside && "max-[1000px]:hidden",
          )}
        >
          {!panel ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
              <Activity size={36} className="text-muted-foreground" />
              <h2 className="font-semibold">{t("monitor.empty")}</h2>
              <p className="max-w-sm text-sm text-muted-foreground">
                {t("monitor.emptyHint")}
              </p>
              <Button onClick={() => startEdit(null)}>
                {t("monitor.createFirst")}
              </Button>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 p-4 pb-2">
                <Combobox
                  options={panels.map((p) => ({
                    value: p.id,
                    label: p.name,
                    sublabel: p.description,
                  }))}
                  value={panel.id}
                  onValueChange={(id) => {
                    setSelected(id);
                    setDetail(null);
                    setEditor(null);
                  }}
                  triggerClassName="w-64 max-w-full shrink-0"
                  clearable={false}
                  ariaLabel={t("monitor.choosePanel")}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("monitor.edit")}
                  onClick={() => startEdit(panel)}
                >
                  <Pencil size={15} />
                </Button>
                <AsideActionMenu>
                  <AsideActionMenuItem
                    onClick={() => {
                      void duplicate();
                    }}
                  >
                    <Copy size={14} className="mr-2" />
                    {t("monitor.copy")}
                  </AsideActionMenuItem>
                  <AsideActionMenuItem
                    variant="destructive"
                    onClick={() => setDeleting(panel)}
                  >
                    <Trash2 size={14} className="mr-2" />
                    {t("monitor.delete")}
                  </AsideActionMenuItem>
                </AsideActionMenu>
                <div className="flex-1" />
                <Button
                  variant={running ? "secondary" : "default"}
                  size="sm"
                  className="gap-1.5"
                  onClick={() =>
                    running
                      ? monitorActions.stop(panel.id)
                      : monitorActions.start(panel.id)
                  }
                >
                  {running ? <Square size={13} /> : <Play size={13} />}
                  {t(running ? "monitor.stop" : "monitor.start")}
                </Button>
              </div>
              {panel.description && (
                <p className="px-4 pb-2 text-xs text-muted-foreground">
                  {panel.description}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2 px-4 py-2">
                <div className="flex rounded-md border border-border/60 p-0.5">
                  {(["list", "charts"] as const).map((view) => (
                    <Button
                      key={view}
                      size="sm"
                      variant={panel.view === view ? "secondary" : "ghost"}
                      className="h-7 gap-1.5"
                      onClick={() => {
                        void patchPanel({ view });
                      }}
                    >
                      {view === "list" ? (
                        <List size={14} />
                      ) : (
                        <LayoutGrid size={14} />
                      )}
                      {t(`monitor.${view}`)}
                    </Button>
                  ))}
                </div>
                <VaultHeaderSearch
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t("monitor.search")}
                  className="min-w-36 flex-1"
                />
                <Select
                  value={String(panel.interval)}
                  onValueChange={(v) => {
                    void patchPanel({
                      interval: Number(v) as MonitorPanel["interval"],
                    });
                  }}
                >
                  <SelectTrigger
                    className="h-8 w-auto text-xs"
                    aria-label={t("monitor.interval")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[10, 30, 60].map((v) => (
                      <SelectItem key={v} value={String(v)}>
                        {t("monitor.seconds", { count: v })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={String(panel.range)}
                  onValueChange={(v) => {
                    void patchPanel({
                      range: Number(v) as MonitorPanel["range"],
                    });
                  }}
                >
                  <SelectTrigger
                    className="h-8 w-auto text-xs"
                    aria-label={t("monitor.range")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[5, 15, 30].map((v) => (
                      <SelectItem key={v} value={String(v)}>
                        {t("monitor.minutes", { count: v })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={panel.sort}
                  onValueChange={(v) => {
                    void patchPanel({ sort: v as MonitorPanel["sort"] });
                  }}
                >
                  <SelectTrigger
                    className="h-8 w-auto text-xs"
                    aria-label={t("monitor.sort")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {["manual", "name", "cpu", "memory", "disk"].map((v) => (
                      <SelectItem key={v} value={v}>
                        {t(`monitor.sort.${v}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-wrap items-center gap-3 px-4 py-2 text-xs text-muted-foreground border-b border-border/40">
                <span>
                  {t("monitor.selectedCount", { count: panel.hostIds.length })}
                </span>
                <span>
                  {t("monitor.liveCount", {
                    count: panel.hostIds.filter(
                      (id) => runtime.hosts[id]?.status === "live",
                    ).length,
                  })}
                </span>
                <Button
                  variant={panel.attentionOnly ? "secondary" : "ghost"}
                  size="sm"
                  className="ml-auto h-7 text-xs"
                  onClick={() => {
                    void patchPanel({ attentionOnly: !panel.attentionOnly });
                  }}
                >
                  {t("monitor.attention")}
                </Button>
              </div>
              <ScrollArea className="min-h-0 flex-1">
                <div className="p-4">
                  {!rows.length ? (
                    <p className="p-8 text-center text-sm text-muted-foreground">
                      {t("monitor.noMatches")}
                    </p>
                  ) : panel.view === "charts" ? (
                    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] gap-3">
                      {rows.map(({ id, host, state }) => (
                        <button
                          key={id}
                          className={cn(
                            "min-w-0 rounded-xl border border-border/60 bg-card p-4 text-left transition-colors hover:bg-muted/30 focus-visible:outline focus-visible:outline-primary",
                            status(host, state) !== "live" &&
                              "text-muted-foreground",
                          )}
                          onClick={() => {
                            setEditor(null);
                            setDetail(id);
                          }}
                        >
                          <div className="flex items-start gap-2 mb-4">
                            <div className="min-w-0 flex-1">
                              <h3 className="truncate text-sm font-semibold">
                                {host?.label ?? t("monitor.missingHost")}
                              </h3>
                              <p className="truncate text-xs text-muted-foreground">
                                {host?.hostname ?? id}
                              </p>
                            </div>
                            {stateBadge(host, state)}
                          </div>
                          {renderMetrics(state)}
                          <div className="mt-3 border-t border-border/40 pt-3">
                            <div className="flex items-center justify-between text-xs">
                              <span>{t("monitor.rootDisk")}</span>
                              <span className="tabular-nums">
                                {percent(state?.stats?.diskPercent)}
                              </span>
                            </div>
                            <div className="mt-1.5 h-1 rounded-full bg-muted">
                              <div
                                className="h-full rounded-full bg-primary"
                                style={{
                                  width: `${Math.min(100, state?.stats?.diskPercent ?? 0)}%`,
                                }}
                              />
                            </div>
                            {state?.stats?.disks
                              .filter(
                                (d) => d.mountPoint !== "/" && d.percent >= 90,
                              )
                              .map((d) => (
                                <p
                                  key={d.mountPoint}
                                  className="mt-1 text-xs text-destructive"
                                >
                                  {d.mountPoint} {percent(d.percent)}
                                </p>
                              ))}
                          </div>
                          <div className="mt-3 flex justify-between text-xs tabular-nums">
                            <span className="flex items-center gap-1">
                              <ArrowDown size={12} />
                              {rate(
                                state?.stats?.networkReady
                                  ? state.stats.netRxSpeed
                                  : null,
                              )}
                            </span>
                            <span className="flex items-center gap-1">
                              <ArrowUp size={12} />
                              {rate(
                                state?.stats?.networkReady
                                  ? state.stats.netTxSpeed
                                  : null,
                              )}
                            </span>
                          </div>
                          <p className="mt-3 text-[10px] text-muted-foreground">
                            {state?.at
                              ? t("monitor.updatedAt", {
                                  time: new Date(state.at).toLocaleTimeString(),
                                })
                              : t("monitor.noSamples")}
                          </p>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="overflow-x-auto rounded-lg border border-border/60">
                      <table className="w-full min-w-[680px] text-xs">
                        <thead className="bg-muted/30 text-muted-foreground">
                          <tr>
                            {[
                              "host",
                              "status",
                              "cpu",
                              "memory",
                              "rootDisk",
                              "network",
                              "updated",
                            ].map((k) => (
                              <th
                                key={k}
                                className="px-3 py-3 text-left font-medium"
                              >
                                {t(`monitor.${k}`)}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map(({ id, host, state }) => {
                            const s = state?.stats;
                            return (
                              <tr
                                key={id}
                                className={cn(
                                  "border-t border-border/40 hover:bg-muted/30",
                                  status(host, state) !== "live" &&
                                    "text-muted-foreground",
                                )}
                              >
                                <td className="px-3 py-3">
                                  <button
                                    className="text-left hover:underline"
                                    onClick={() => {
                                      setEditor(null);
                                      setDetail(id);
                                    }}
                                  >
                                    <div className="font-medium">
                                      {host?.label ?? t("monitor.missingHost")}
                                    </div>
                                    <div className="text-[10px] text-muted-foreground">
                                      {host?.hostname ?? id}
                                    </div>
                                  </button>
                                </td>
                                <td className="px-3">
                                  {stateBadge(host, state)}
                                </td>
                                <td className="px-3 tabular-nums">
                                  {percent(s?.cpu)}
                                </td>
                                <td className="px-3 tabular-nums">
                                  {percent(
                                    s?.memTotal && s.memUsed != null
                                      ? (s.memUsed / s.memTotal) * 100
                                      : null,
                                  )}
                                </td>
                                <td className="px-3 tabular-nums">
                                  {percent(s?.diskPercent)}
                                  {s?.disks.some((d) => d.percent >= 90) && (
                                    <span className="ml-1 text-destructive">
                                      !
                                    </span>
                                  )}
                                </td>
                                <td className="px-3 tabular-nums whitespace-nowrap">
                                  ↓{" "}
                                  {rate(s?.networkReady ? s.netRxSpeed : null)}
                                  <br />↑{" "}
                                  {rate(s?.networkReady ? s.netTxSpeed : null)}
                                </td>
                                <td className="px-3 whitespace-nowrap">
                                  {state?.at
                                    ? new Date(state.at).toLocaleTimeString()
                                    : "--"}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <p className="pt-4 text-[11px] leading-relaxed text-muted-foreground">
                    {t("monitor.memoryOnlyHint")}
                  </p>
                </div>
              </ScrollArea>
            </>
          )}
        </div>
        {editor && !selecting && (
          <AsidePanel
            open
            onClose={() => setEditor(null)}
            title={t(editor.base ? "monitor.edit" : "monitor.create")}
            layout="inline"
            width="w-[380px]"
            className="max-[1000px]:!w-full max-[1000px]:border-l-0"
          >
            <AsidePanelContent>
              <div className="space-y-2">
                <Label htmlFor="monitor-name">{t("monitor.name")}</Label>
                <Input
                  id="monitor-name"
                  autoFocus
                  maxLength={120}
                  value={editor.draft.name}
                  onChange={(e) => updateDraft({ name: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="monitor-description">
                  {t("monitor.description")}
                </Label>
                <Textarea
                  id="monitor-description"
                  maxLength={1000}
                  value={editor.draft.description}
                  onChange={(e) => updateDraft({ description: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>{t("monitor.hosts")}</Label>
                <Button
                  variant="outline"
                  className="w-full justify-between"
                  onClick={() => setSelecting(true)}
                >
                  {t("monitor.selectedCount", {
                    count: editor.draft.hostIds.length,
                  })}
                  <Plus size={14} />
                </Button>
                <p className="text-xs text-muted-foreground">
                  {t("monitor.selectionHint")}
                </p>
              </div>
              <div className="space-y-2">
                {editor.draft.hostIds.map((id, index) => (
                  <div
                    key={id}
                    className="flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-xs"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {hosts.find((h) => h.id === id)?.label ??
                        t("monitor.missingHost")}
                    </span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      disabled={!index}
                      aria-label={t("monitor.moveUp")}
                      onClick={() => {
                        const ids = [...editor.draft.hostIds];
                        [ids[index - 1], ids[index]] = [
                          ids[index],
                          ids[index - 1],
                        ];
                        updateDraft({ hostIds: ids });
                      }}
                    >
                      <ArrowUp size={13} />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      aria-label={t("monitor.removeHost")}
                      onClick={() =>
                        updateDraft({
                          hostIds: editor.draft.hostIds.filter((h) => h !== id),
                        })
                      }
                    >
                      <Trash2 size={13} />
                    </Button>
                  </div>
                ))}
              </div>
              <div className="space-y-2">
                <Label>{t("monitor.defaultView")}</Label>
                <Select
                  value={editor.draft.view}
                  onValueChange={(v) =>
                    updateDraft({ view: v as MonitorPanel["view"] })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="list">{t("monitor.list")}</SelectItem>
                    <SelectItem value="charts">
                      {t("monitor.charts")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("monitor.saveHint")}
              </p>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {t(error)}
                </p>
              )}
            </AsidePanelContent>
            <AsidePanelFooter>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => setEditor(null)}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  className="flex-1"
                  disabled={saving}
                  onClick={() => {
                    void save();
                  }}
                >
                  {t("common.save")}
                </Button>
              </div>
            </AsidePanelFooter>
          </AsidePanel>
        )}
        {editor && selecting && (
          <SelectHostPanel
            hosts={hosts}
            customGroups={customGroups}
            selectedHostIds={editor.draft.hostIds}
            multiSelect
            onSelect={() => {}}
            onSelectionChange={(hostIds) => updateDraft({ hostIds })}
            onBack={() => setSelecting(false)}
            onContinue={() => setSelecting(false)}
            title={t("monitor.chooseHosts")}
            subtitle={t("monitor.selectionHint")}
            layout="inline"
            className="max-[1000px]:!w-full max-[1000px]:border-l-0"
          />
        )}
        {detail && (
          <AsidePanel
            open
            onClose={() => setDetail(null)}
            title={hostDetail?.label ?? t("monitor.missingHost")}
            subtitle={hostDetail?.hostname}
            layout="inline"
            width="w-[380px]"
            className="max-[1000px]:!w-full max-[1000px]:border-l-0"
          >
            <AsidePanelContent>
              {stateBadge(hostDetail, detailState)}
              {["login", "error", "disconnected"].includes(
                detailState?.status ?? "",
              ) && (
                <>
                  <p className="text-xs text-muted-foreground">
                    {t("monitor.loginHint")}
                  </p>
                  <div className="space-y-2">
                    <Label htmlFor="monitor-login-user">
                      {t("monitor.username")}
                    </Label>
                    <Input
                      id="monitor-login-user"
                      autoComplete="off"
                      value={
                        login.hostId === detail
                          ? login.username
                          : (hostDetail?.username ?? "")
                      }
                      onChange={(e) =>
                        setLogin((prev) => ({
                          hostId: detail,
                          username: e.target.value,
                          password: prev.hostId === detail ? prev.password : "",
                        }))
                      }
                    />
                    <Label htmlFor="monitor-login-password">
                      {t("monitor.password")}
                    </Label>
                    <Input
                      id="monitor-login-password"
                      type="password"
                      autoComplete="new-password"
                      value={login.hostId === detail ? login.password : ""}
                      onChange={(e) =>
                        setLogin((prev) => ({
                          hostId: detail,
                          username:
                            prev.hostId === detail
                              ? prev.username
                              : (hostDetail?.username ?? ""),
                          password: e.target.value,
                        }))
                      }
                    />
                  </div>
                  <Button
                    variant="outline"
                    onClick={() => {
                      monitorActions.retry(
                        detail,
                        login.hostId === detail && login.password
                          ? {
                              username: login.username,
                              password: login.password,
                            }
                          : undefined,
                      );
                      setLogin({ hostId: "", username: "", password: "" });
                    }}
                  >
                    {t("monitor.retry")}
                  </Button>
                </>
              )}
              {renderMetrics(detailState, true)}
              <p className="text-xs text-muted-foreground">
                {t("monitor.observed", {
                  count: detailState?.points.length
                    ? Math.floor(
                        (Date.now() - detailState.points[0].at) / 60000,
                      )
                    : 0,
                })}
              </p>
              <div className="space-y-2">
                <h3 className="text-sm font-medium">{t("monitor.network")}</h3>
                <div className="flex justify-between text-xs">
                  <span>
                    ↓{" "}
                    {rate(
                      detailState?.stats?.networkReady
                        ? detailState.stats.netRxSpeed
                        : null,
                    )}
                  </span>
                  <span>
                    ↑{" "}
                    {rate(
                      detailState?.stats?.networkReady
                        ? detailState.stats.netTxSpeed
                        : null,
                    )}
                  </span>
                </div>
                {panel && (
                  <>
                    <MonitorTrend
                      points={detailState?.points ?? []}
                      field="rx"
                      range={panel.range}
                      interval={panel.interval}
                      label={t("monitor.downloadTrend")}
                    />
                    <MonitorTrend
                      points={detailState?.points ?? []}
                      field="tx"
                      range={panel.range}
                      interval={panel.interval}
                      label={t("monitor.uploadTrend")}
                    />
                  </>
                )}
                {detailState?.stats?.netInterfaces.map((iface) => (
                  <div
                    key={iface.name}
                    className="flex flex-wrap justify-between gap-2 text-xs"
                  >
                    <span>{iface.name}</span>
                    <span>
                      ↓{" "}
                      {rate(
                        detailState.stats?.networkReady ? iface.rxSpeed : null,
                      )}{" "}
                      ↑{" "}
                      {rate(
                        detailState.stats?.networkReady ? iface.txSpeed : null,
                      )}
                    </span>
                  </div>
                ))}
              </div>
              <div className="space-y-2">
                <h3 className="text-sm font-medium">{t("monitor.disks")}</h3>
                {detailState?.stats?.disks.map((d) => (
                  <div key={d.mountPoint} className="text-xs">
                    <div className="flex justify-between">
                      <span className="break-all">{d.mountPoint}</span>
                      <span
                        className={d.percent >= 90 ? "text-destructive" : ""}
                      >
                        {percent(d.percent)}
                      </span>
                    </div>
                    <p className="text-muted-foreground">
                      {d.used.toFixed(1)} / {d.total.toFixed(1)} GiB
                    </p>
                  </div>
                ))}
              </div>
              <div className="space-y-1 text-xs text-muted-foreground">
                <h3 className="font-medium text-foreground">
                  {t("monitor.system")}
                </h3>
                <p>{detailState?.stats?.osName ?? "--"}</p>
                <p>{detailState?.stats?.kernelRelease ?? "--"}</p>
                <p>{detailState?.stats?.hostname ?? "--"}</p>
              </div>
              {detailState?.status === "unsupported" && (
                <p className="text-xs text-muted-foreground">
                  {t("monitor.unsupportedHint")}
                </p>
              )}
              {!hostDetail && panel && (
                <Button
                  variant="outline"
                  onClick={() => {
                    void patchPanel({
                      hostIds: panel.hostIds.filter((id) => id !== detail),
                    });
                    setDetail(null);
                  }}
                >
                  {t("monitor.removeHost")}
                </Button>
              )}
            </AsidePanelContent>
            <AsidePanelFooter>
              <Button
                className="w-full gap-2"
                disabled={!hostDetail}
                onClick={() => hostDetail && onConnect(hostDetail)}
              >
                <Terminal size={14} />
                {t("monitor.openTerminal")}
              </Button>
            </AsidePanelFooter>
          </AsidePanel>
        )}
      </div>
      <Dialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("monitor.delete")}</DialogTitle>
            <DialogDescription>
              {t("monitor.deleteHint", { name: deleting?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!deleting) return;
                void deleteMonitorPanel(deleting.id)
                  .then(() => {
                    monitorActions.stop(deleting.id);
                    setDeleting(null);
                    setDetail(null);
                    setEditor(null);
                  })
                  .catch(() => toast.error(t("monitor.saveFailed")));
              }}
            >
              {t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
