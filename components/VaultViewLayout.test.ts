import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const vaultViewLayoutSource = readFileSync(new URL("./vault/VaultViewLayout.tsx", import.meta.url), "utf8");
const pluginImporterCommitHookSource = readFileSync(new URL("../application/state/usePluginImporterCommit.ts", import.meta.url), "utf8");

test("vault stage aligns its content to the top tab bar", () => {
  assert.match(vaultViewLayoutSource, /className="flex min-w-0 flex-1 py-0 pr-2 pb-2 pl-0"/);
  assert.doesNotMatch(vaultViewLayoutSource, /className="flex min-w-0 flex-1 p-2 pl-0"/);
});

test("vault notes stay mounted while switching sections", () => {
  assert.match(vaultViewLayoutSource, /data-section="vault-notes-retained"/);
  assert.match(vaultViewLayoutSource, /currentSection !== "notes" && "hidden"/);
  assert.doesNotMatch(vaultViewLayoutSource, /currentSection === "notes" && \(\s*<NotesManager/);
});

test("vault header collapsed actions cannot retain hidden focus", () => {
  assert.match(vaultViewLayoutSource, /newHostActionsRef\.current\?\.contains\(activeElement\)/);
  assert.match(vaultViewLayoutSource, /sessionActionsRef\.current\?\.contains\(activeElement\)/);
  assert.match(vaultViewLayoutSource, /activeElement\.blur\(\)/);
  // Both the SSH/new-host panel and the local-shell host panel collapse the
  // header actions so hidden buttons cannot retain focus.
  assert.match(vaultViewLayoutSource, /aria-hidden=\{isHostAsideOpen \? true : undefined\}/);
  assert.match(vaultViewLayoutSource, /inert=\{isHostAsideOpen \? true : undefined\}/);
});

test("vault sidebar toggle keeps an accessible action label", () => {
  assert.match(
    vaultViewLayoutSource,
    /aria-label=\{sidebarCollapsed \? t\("vault\.sidebar\.expand"\) : t\("vault\.sidebar\.collapse"\)\}/,
  );
});

test("keychain deletion clears the remembered passphrase through the vault handler", () => {
  assert.match(vaultViewLayoutSource, /const handleDeleteVaultKey = React\.useCallback/);
  assert.match(vaultViewLayoutSource, /void deleteVaultKey\(\{/);
  assert.match(vaultViewLayoutSource, /onDelete=\{handleDeleteVaultKey\}/);
});

test("plugin importer merge and commit workflow is owned by application state", () => {
  assert.match(vaultViewLayoutSource, /usePluginImporterCommit\(\{/);
  assert.doesNotMatch(vaultViewLayoutSource, /normalizePluginImporterRecords|mergePluginImporterDrafts|buildPluginImporterSafePreview/);
  assert.match(pluginImporterCommitHookSource, /normalizePluginImporterRecords/);
  assert.match(pluginImporterCommitHookSource, /mergePluginImporterDrafts/);
  assert.match(pluginImporterCommitHookSource, /buildPluginImporterSafePreview/);
});

test("host list section receives marquee selection and batched group move", () => {
  const sectionStart = vaultViewLayoutSource.indexOf("<VaultHostListSection");
  const sectionEnd = vaultViewLayoutSource.indexOf("/>", sectionStart);
  const section = vaultViewLayoutSource.slice(sectionStart, sectionEnd);
  assert.match(section, /\bmoveHostsToGroup,/);
  assert.match(section, /\bsetIsMultiSelectMode,/);
  assert.match(section, /\bsetSelectedHostIds,/);
});

test("Vault import entry is disabled while an import is running", () => {
  assert.match(vaultViewLayoutSource, /disabled=\{importProgress\?\.status === "running"\}/);
  assert.match(vaultViewLayoutSource, /if \(importProgress\?\.status === "running"\) return;/);
});

test("new host menu keeps the local shell icon at the same size as its siblings", () => {
  const menuStart = vaultViewLayoutSource.indexOf('<DropdownContent className="flex w-max min-w-44 flex-col" align="end" alignToParent>');
  assert.ok(menuStart >= 0);
  const menuEnd = vaultViewLayoutSource.indexOf("</DropdownContent>", menuStart);
  const menu = vaultViewLayoutSource.slice(menuStart, menuEnd);
  assert.match(menu, /className="flex w-max min-w-44 flex-col"/);
  assert.doesNotMatch(menu, /className="w-44"/);
  assert.match(menu, /<TerminalSquare size=\{14\} className="shrink-0" \/>/);
  assert.match(menu, /<FolderTree size=\{14\} className="shrink-0" \/>/);
  assert.match(menu, /<Upload size=\{14\} className="shrink-0" \/>/);
  assert.match(menu, /<Download size=\{14\} className="shrink-0" \/>/);
  assert.doesNotMatch(menu, /className="w-full justify-start gap-2"/);
});
