"use strict";

const path = require("node:path");
const NETWORK_CREDENTIAL_LEASE_FEATURE = require("./generated/plugin-contract.schema.json").$defs.NetworkCredentialLeaseFeature.const;
const VAULT_PAGES_FEATURE = require("./generated/plugin-contract.schema.json").$defs.VaultPagesFeature.const;
const TERMINAL_SIDEBAR_FEATURE = require("./generated/plugin-contract.schema.json").$defs.TerminalSidebarFeature.const;
const INTERACTIVE_COMMAND_FEATURE = require("./generated/plugin-contract.schema.json").$defs.InteractiveCommandFeature.const;

const { assertBrowserOnlyPlugin } = require("../../domain/pluginRuntimePolicy.cjs");
const { isPluginDevelopmentEnabled, PLUGIN_API_VERSION } = require("./constants.cjs");
const { PluginDatabase } = require("./database.cjs");
const { PluginCompanionSupervisor } = require("./companionSupervisor.cjs");
const { PluginCredentialBroker, assertLeaseParams } = require("./credentialBroker.cjs");
const { PluginCredentialCatalog } = require("./credentialCatalog.cjs");
const { PluginContributionService } = require("./contributionService.cjs");
const { PluginContributionIconService } = require("./contributionIconService.cjs");
const { PluginFilesystemBroker } = require("./filesystemBroker.cjs");
const { createDefaultPluginHostRpcRegistry } = require("./hostRpcRegistry.cjs");
const {
  createDefaultPluginModuleResources,
  createUtilityModuleMappings,
  normalizePluginModuleResources,
} = require("./moduleResources.cjs");
const { MarketSourcesService } = require("./marketSourcesService.cjs");
const { PluginThemeService } = require("./themeService.cjs");
const { PackageStore } = require("./packageStore.cjs");
const { createPluginPaths } = require("./paths.cjs");
const { PluginManager } = require("./pluginManager.cjs");
const { PluginNetworkBroker } = require("./networkBroker.cjs");
const { PluginByteStreamService, FEATURE: BYTE_STREAM_FEATURE } = require("./byteStreamService.cjs");
const { PluginAIContextService, PLUGIN_AI_CONTEXT_FEATURES } = require("./ai/aiContextService.cjs");
const { PluginAITrustedHostAdapter } = require("./ai/trustedHostAdapter.cjs");
const { HOST_INTERACTION_FEATURE, PluginHostInteractionService } = require("./hostInteractionService.cjs");
const { PluginPermissionEngine } = require("./permissionEngine.cjs");
const { PluginProtocol } = require("./pluginProtocol.cjs");
const { PluginViewHost } = require("./pluginViewHost.cjs");
const {
  RuntimeSupervisor,
  assertStorageParams,
  resolveDefaultRuntimeKind,
} = require("./runtimeSupervisor.cjs");
const { PluginQuotaManager } = require("./quotaManager.cjs");
const { registerSecurePluginCapabilities } = require("./secureCapabilities.cjs");
const { PluginSecretStore } = require("./secretStore.cjs");
const { SecretLeaseStore } = require("./secretLease.cjs");
const { PluginTerminalProviderService } = require("./terminalProviderService.cjs");
const { PluginTerminalDataPipelineService } = require("./terminalDataPipelineService.cjs");
const { PluginExtensionProviderService } = require("./extensionProviderService.cjs");
const { PluginSyncSidecarService } = require("./pluginSyncSidecarService.cjs");

function getElectronProcessMetrics(app, pid) {
  const metric = app.getAppMetrics?.().find((candidate) => candidate.pid === pid);
  if (!metric) return null;
  return {
    cpuPercent: Number(metric.cpu?.percentCPUUsage ?? 0),
    memoryBytes: Number(metric.memory?.workingSetSize ?? 0) * 1024,
  };
}

/**
 * Full installed-manifest catalog of sync providers (active + inactive versions).
 * Shared by startup and enable-time backfill so ambiguity checks always see
 * cross-plugin / nested-namespace claims.
 * @param {{ listInstalledVersions?: () => Array<{ pluginId?: string, manifest?: { contributes?: { providers?: Array<{ kind?: string, id?: string }> } } }> }} database
 * @returns {Array<{ pluginId: string, provider: { id: string } }>}
 */
function collectInstalledSyncProviderCatalog(database) {
  const installedSyncProviders = [];
  const seen = new Set();
  const versions = typeof database.listInstalledVersions === "function"
    ? database.listInstalledVersions()
    : [];
  for (const version of versions) {
    const pluginId = version?.pluginId;
    if (typeof pluginId !== "string" || !version.manifest) continue;
    for (const provider of version.manifest.contributes?.providers ?? []) {
      if (provider?.kind !== "sync") continue;
      if (typeof provider.id !== "string" || provider.id.length < 1) continue;
      const key = `${pluginId}\0${provider.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      installedSyncProviders.push({
        pluginId,
        provider: { id: provider.id },
      });
    }
  }
  return installedSyncProviders;
}

function createPluginHostService(options) {
  const allowAdvancedPlugins = isPluginDevelopmentEnabled(options.env ?? process.env);
  const paths = createPluginPaths(options.app.getPath("userData"));
  const appRoot = options.appRoot ?? options.app.getAppPath();
  const runtimeDirectory = options.runtimeDirectory ?? path.join(__dirname, "runtime");
  const supportedFeatures = [...new Set(["terminal.input-drafts", "terminal.selection-sharing", "appearance.theme-packs", "metadata.brand-icon", BYTE_STREAM_FEATURE, ...PLUGIN_AI_CONTEXT_FEATURES, NETWORK_CREDENTIAL_LEASE_FEATURE, HOST_INTERACTION_FEATURE, VAULT_PAGES_FEATURE, TERMINAL_SIDEBAR_FEATURE, INTERACTIVE_COMMAND_FEATURE, ...(options.supportedFeatures ?? [])])];
  const database = new PluginDatabase(paths.database);
  let interactionService;
  let byteStreamService;
  let aiContextService;
  let aiHostAdapter;
  try {
    const packageStore = new PackageStore({
      allowAdvancedPlugins,
      paths,
      database,
      netcattyVersion: options.app.getVersion(),
      apiVersion: PLUGIN_API_VERSION,
      supportedFeatures,
    });
    const contributionIconService = new PluginContributionIconService({
      database,
      packageStore,
      BrowserWindow: options.electron.BrowserWindow,
      rasterizeIcon: options.rasterizeContributionIcon,
    });
    const moduleResources = options.moduleResources
      ? normalizePluginModuleResources(options.moduleResources)
      : createDefaultPluginModuleResources(appRoot, options.additionalModuleResources ?? []);
    const protocol = new PluginProtocol({
      runtimeDirectory,
      moduleResources,
    });
    const permissionEngine = new PluginPermissionEngine({
      database,
      requestDecision: options.requestPermissionDecision,
    });
    const quotaManager = new PluginQuotaManager({
      getProcessMetrics: options.getProcessMetrics
        ?? ((pid) => getElectronProcessMetrics(options.app, pid)),
      quotas: options.quotas,
    });
    const secretStore = new PluginSecretStore({
      database,
      safeStorage: options.safeStorage ?? options.electron.safeStorage,
    });
    const leaseStore = new SecretLeaseStore({ secretStore });
    const credentialResolver = options.credentialResolver ?? new PluginCredentialCatalog({
      safeStorage: options.safeStorage ?? options.electron.safeStorage,
    });
    const credentialBroker = new PluginCredentialBroker({
      secretStore,
      leaseStore,
      credentialResolver,
    });
    const filesystemBroker = new PluginFilesystemBroker({
      quotaManager,
      openDirectoryHandle: options.openPluginDirectoryHandle,
    });
    const networkBroker = new PluginNetworkBroker({
      fetch: options.fetch ?? (options.electron.net?.fetch
        ? (...args) => options.electron.net.fetch(...args)
        : undefined),
      permissionEngine,
      quotaManager,
    });
    let runtimeSupervisor;
    const companionSupervisor = new PluginCompanionSupervisor({
      paths,
      quotaManager,
      spawn: options.spawnCompanion,
      onContainmentFailure: (identity, error) => (
        runtimeSupervisor?.enforcePolicyViolation(identity, error)
      ),
    });
    const rpcRegistry = options.rpcRegistry ?? createDefaultPluginHostRpcRegistry({
      assertStorageParams,
      database,
    });
    const runtimeAccess = Object.freeze({
      start: (...args) => runtimeSupervisor.start(...args),
      request: (...args) => runtimeSupervisor.request(...args),
      notify: (...args) => runtimeSupervisor.notify(...args),
      getRuntimeIdentity: (...args) => runtimeSupervisor.getRuntimeIdentity(...args),
    });
    const contributionService = new PluginContributionService({
      database,
      runtimeSupervisor: runtimeAccess,
      secretStore,
      getLocale: options.getLocale,
      onCommandFinished: (runtimeId) => interactionService?.cancelRuntimeRequests(runtimeId),
    });
    contributionService.registerRpcCapabilities(rpcRegistry);
    registerSecurePluginCapabilities(rpcRegistry, {
      assertLeaseParams,
      companionSupervisor,
      credentialBroker,
      filesystemBroker,
      networkBroker,
      permissionEngine,
      quotaManager,
      secretStore,
    });
    interactionService = new PluginHostInteractionService({
      database, permissionEngine, quotaManager,
      clipboard: options.electron.clipboard,
      getWindow: options.getInteractionWindow,
      isLocked: options.isAppLocked,
      subscribeLock: options.subscribeAppLock,
      getTerminalWorkerManager: options.getTerminalWorkerManager,
    });
    interactionService.registerRpcCapabilities(rpcRegistry);
    const configuredRegistry = options.configureRpcRegistry?.(rpcRegistry);
    if (configuredRegistry && typeof configuredRegistry.then === "function") {
      throw new TypeError("Plugin host RPC registry configuration must be synchronous");
    }
    const requestedRuntimeResolver = options.resolveRuntimeKind ?? resolveDefaultRuntimeKind;
    const resolveRuntimeKind = async (context) => {
      if (!allowAdvancedPlugins) assertBrowserOnlyPlugin(context.plugin.manifest);
      const kind = await requestedRuntimeResolver(context);
      if (
        (kind !== "browser" && kind !== "utility")
        || !context.availableKinds.includes(kind)
      ) throw new Error(`Plugin runtime selection is unavailable: ${String(kind)}`);
      if (!allowAdvancedPlugins && kind !== "browser") throw new Error("Advanced plugin runtime requires developer mode");
      await permissionEngine.authorizeRequired(context.plugin, {
        securityPrincipal: context.securityPrincipal,
        signal: context.signal,
        skipPermissions: ["runtime.advanced"],
      });
      if (kind === "utility") {
        await permissionEngine.authorize({
          pluginId: context.plugin.id,
          pluginVersion: context.plugin.activeVersion,
          runtimeId: null,
          manifest: context.plugin.manifest,
          securityPrincipal: context.securityPrincipal,
          signal: context.signal,
        }, {
          permission: "runtime.advanced",
          resources: ["*"],
          reason: "Start an advanced runtime with full Node, filesystem, and network authority",
          operationId: `runtime.advanced:${context.plugin.activeVersion}`,
        });
      }
      return kind;
    };
    const runtimeMessageGuard = (identity, message) => {
      quotaManager.guardMessage(identity, message);
      return options.runtimeMessageGuard?.(identity, message);
    };
    runtimeSupervisor = new RuntimeSupervisor({
      electron: options.electron,
      database,
      packageStore,
      protocol,
      paths,
      netcattyVersion: options.app.getVersion(),
      apiVersion: PLUGIN_API_VERSION,
      supportedFeatures,
      runtimeDirectory,
      appRoot,
      rpcRegistry,
      resolveRuntimeKind,
      resolveSecurityPrincipal: options.resolveSecurityPrincipal,
      runtimeMessageGuard,
      getInitialEnvironment: () => contributionService.getEnvironment(),
      runtimeResourceMonitor: quotaManager,
      runtimeCleanup: async (identity) => {
        byteStreamService?.releaseRuntime(identity.runtimeId);
        aiContextService?.releaseRuntime(identity.runtimeId);
        interactionService?.releaseRuntime(identity.runtimeId);
        leaseStore.revokeRuntime(identity.runtimeId);
        await companionSupervisor.releaseRuntime(identity.runtimeId);
      },
      utilityModuleMappings: options.utilityModuleMappings ?? createUtilityModuleMappings(moduleResources),
    });
    byteStreamService = new PluginByteStreamService({ database, permissionEngine, quotaManager, runtimeSupervisor });
    byteStreamService.register(rpcRegistry);
    aiHostAdapter = options.pluginAIHostAdapter ?? new PluginAITrustedHostAdapter({
      getWindow: options.getInteractionWindow ?? (() => null),
      isLocked: options.isAppLocked,
      subscribeLock: options.subscribeAppLock,
      dialog: options.electron.dialog,
    });
    if (options.electron.ipcMain) aiHostAdapter.registerIpc?.(options.electron.ipcMain);
    aiContextService = new PluginAIContextService({ database, permissionEngine,
      getRuntimeIdentity: (pluginId) => runtimeSupervisor.getRuntimeIdentity(pluginId),
      hostAdapter: aiHostAdapter,
    });
    aiContextService.registerRpcCapabilities(rpcRegistry);
    const originalOnPluginDisabled = contributionService.onPluginDisabled.bind(contributionService);
    contributionService.onPluginDisabled = (pluginId) => {
      aiContextService.releasePlugin(pluginId);
      return originalOnPluginDisabled(pluginId);
    };
    runtimeSupervisor.onDidChangeRuntime((event) => contributionService.onRuntimeStateChanged(event));
    const terminalProviderService = new PluginTerminalProviderService({
      contributionService,
      permissionEngine,
      runtimeSupervisor,
    });
    const extensionProviderService = new PluginExtensionProviderService({
      contributionService,
      leaseStore,
      permissionEngine,
      rpcRegistry,
      runtimeSupervisor,
    });
    const syncSidecarService = new PluginSyncSidecarService({
      database,
      contributionService,
    });
    // Replay retained cloud sidecars into plugin_settings before the plugin
    // runtime starts so onStartupFinished sees hydrated values.
    const originalOnPluginEnabled = contributionService.onPluginEnabled.bind(contributionService);
    contributionService.onPluginEnabled = async (pluginId) => {
      try {
        await syncSidecarService.hydrateInstalledPluginSettings(pluginId);
      } catch {
        // Hydration is best-effort; enable must still succeed.
      }
      const enabled = await originalOnPluginEnabled(pluginId);
      try {
        // Use the same installed-manifest catalog as startup so cross-plugin /
        // inactive-version ambiguity checks still apply when only this plugin
        // was just enabled (Codex P2 on d3a9b94c).
        if (typeof secretStore.backfillSyncProviderBindingsFromLiveProviders === "function") {
          secretStore.backfillSyncProviderBindingsFromLiveProviders(
            collectInstalledSyncProviderCatalog(database),
          );
        }
      } catch {
        // Best-effort; enable must still succeed.
      }
      return enabled;
    };
    // Live-provider seed must wait until PackageStore.recover() has restored
    // missing plugin_versions. Construction-time seed can bind a stale owner
    // against an incomplete catalog; post-recovery seed then skips it as
    // existing (Codex P2 on f2b1b5d8). syncDeleteSecrets already awaits
    // resolveManager() → package initialize, so cleanup sees the post-recovery
    // seed without racing an early incomplete bind.
    const seedSyncBindings = () => {
      if (typeof secretStore.backfillSyncProviderBindingsFromLiveProviders !== "function") return;
      secretStore.backfillSyncProviderBindingsFromLiveProviders(
        collectInstalledSyncProviderCatalog(database),
      );
    };
    // PackageStore.recover() repopulates plugin_versions; only then promote
    // legacy maps and seed live bindings (Codex P2 on dd7aad70 / f2b1b5d8).
    const originalPackageInitialize = packageStore.initialize.bind(packageStore);
    packageStore.initialize = async () => {
      const result = await originalPackageInitialize();
      try {
        if (typeof database.backfillSyncProviderBindingsFromLegacySecrets === "function") {
          database.backfillSyncProviderBindingsFromLegacySecrets();
        }
        seedSyncBindings();
      } catch {
        // Best-effort
      }
      return result;
    };
    // Startup activation goes through contributionService.initialize() → #startPlugin
    // without onPluginEnabled. Hydrate every enabled plugin before that path runs.
    const originalInitialize = contributionService.initialize.bind(contributionService);
    contributionService.initialize = async () => {
      for (const plugin of database.listPlugins()) {
        if (!plugin?.enabled || typeof plugin.id !== "string") continue;
        try {
          await syncSidecarService.hydrateInstalledPluginSettings(plugin.id);
        } catch {
          // Best-effort; startup must continue.
        }
      }
      // Re-seed after any package catalog changes during init.
      try {
        if (typeof secretStore.backfillSyncProviderBindingsFromLiveProviders === "function") {
          secretStore.backfillSyncProviderBindingsFromLiveProviders(
            collectInstalledSyncProviderCatalog(database),
          );
        }
      } catch {
        // Best-effort; startup must continue.
      }
      return originalInitialize();
    };
    const terminalDataPipelineService = options.electron.MessageChannelMain
      ? new PluginTerminalDataPipelineService({
          contributionService,
          permissionEngine,
          runtimeSupervisor,
          MessageChannelMain: options.electron.MessageChannelMain,
          requestSelection: options.requestTerminalInterceptorSelection,
          showWarning: options.showTerminalInterceptorWarning,
        })
      : null;
    quotaManager.setViolationHandler((identity, error) => (
      runtimeSupervisor.enforcePolicyViolation(identity, error)
    ));
    const viewHost = options.electron.WebContentsView && options.electron.ipcMain
      ? new PluginViewHost({
          electron: options.electron,
          protocol,
          packageStore,
          database,
          contributionService,
          isLocked: options.isAppLocked,
          subscribeLock: options.subscribeAppLock,
        })
      : null;
    const themeService = new PluginThemeService({database,packageStore,contributionService});
    const manager = new PluginManager({
      secretStore,
      permissionEngine,
      database,
      packageStore,
      runtimeSupervisor,
      contributionService,
      beforeClose: async () => {
        themeService.shutdown();
        interactionService.shutdown();
        byteStreamService.shutdown();
        aiContextService.shutdown();
        terminalDataPipelineService?.shutdown();
        extensionProviderService.shutdown();
        credentialResolver.shutdown?.();
        await viewHost?.shutdown();
        await companionSupervisor.shutdown();
        leaseStore.shutdown();
        permissionEngine.shutdown();
        quotaManager.shutdown();
      },
    });
    return {
      themeService,
      interactionService,
      catalogService: new MarketSourcesService({ database, manager, fetch: options.electron.net?.fetch?.bind(options.electron.net) }),
      companionSupervisor,
      contributionIconService,
      contributionService,
      credentialBroker,
      credentialResolver,
      database,
      filesystemBroker,
      extensionProviderService,
      syncSidecarService,
      leaseStore,
      manager,
      moduleResources,
      packageStore,
      paths,
      protocol,
      networkBroker,
      byteStreamService,
      aiContextService,
      permissionEngine,
      quotaManager,
      rpcRegistry,
      runtimeSupervisor,
      secretStore,
      terminalProviderService,
      terminalDataPipelineService,
      viewHost,
    };
  } catch (error) {
    try { interactionService?.shutdown(); } catch {}
    try { byteStreamService?.shutdown(); } catch {}
    try { aiContextService?.shutdown(); } catch {}
    if (!aiContextService) { try { aiHostAdapter?.shutdown?.(); } catch {} }
    database.close();
    throw error;
  }
}

module.exports = { createPluginHostService, getElectronProcessMetrics };
