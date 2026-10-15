import test from "node:test";
import assert from "node:assert/strict";

import type { Snippet } from "./models.ts";
import {
  buildSnippetExportPayload,
  combineSnippetImportPayloads,
  mergeSnippetImportPayload,
  parseSnippetImportPayload,
} from "./snippetTransfer.ts";

const snippet = (overrides: Partial<Snippet> & Pick<Snippet, "id" | "label" | "command">): Snippet => ({
  tags: [],
  package: "",
  targets: [],
  ...overrides,
});

test("buildSnippetExportPayload removes host target bindings", () => {
  const payload = buildSnippetExportPayload({
    snippets: [
      snippet({
        id: "snippet-1",
        label: "Restart nginx",
        command: "sudo systemctl restart nginx",
        package: "ops/web",
        targets: ["host-1", "host-2"],
      }),
    ],
    snippetPackages: ["ops", "ops/web", "unused"],
    exportedAt: "2026-06-23T00:00:00.000Z",
  });

  assert.equal(payload.kind, "netcatty.snippets");
  assert.deepEqual(payload.snippetPackages, ["ops", "ops/web"]);
  assert.deepEqual(payload.snippets, [
    {
      label: "Restart nginx",
      command: "sudo systemctl restart nginx",
      tags: [],
      package: "ops/web",
    },
  ]);
});

test("mergeSnippetImportPayload skips snippets with duplicate commands", () => {
  const existing = [
    snippet({ id: "local-1", label: "Local uptime", command: "uptime", order: 1000 }),
  ];
  const payload = parseSnippetImportPayload(JSON.stringify({
    kind: "netcatty.snippets",
    version: 1,
    exportedAt: "2026-06-23T00:00:00.000Z",
    snippetPackages: ["ops"],
    snippets: [
      { label: "Remote uptime", command: "uptime", package: "ops" },
      { label: "Disk free", command: "df -h", package: "ops" },
    ],
  }));

  const result = mergeSnippetImportPayload({
    existingSnippets: existing,
    existingSnippetPackages: [],
    payload,
    conflictAction: "skip",
    createId: () => "new-1",
  });

  assert.deepEqual(result.stats, {
    imported: 1,
    overwritten: 0,
    skipped: 1,
    conflicts: 1,
  });
  assert.deepEqual(result.snippets.map((item) => [item.id, item.label, item.command, item.package]), [
    ["local-1", "Local uptime", "uptime", ""],
    ["new-1", "Disk free", "df -h", "ops"],
  ]);
  assert.deepEqual(result.snippetPackages, ["ops"]);
});

test("parseSnippetImportPayload accepts a plain JSON array of snippets", () => {
  const payload = parseSnippetImportPayload(JSON.stringify([
    { label: "List files", command: "ls -la", package: "basics" },
    { command: "pwd" },
  ]));

  assert.equal(payload.kind, "netcatty.snippets");
  assert.deepEqual(payload.snippetPackages, ["basics"]);
  assert.deepEqual(payload.snippets.map((item) => [item.label, item.command, item.package]), [
    ["List files", "ls -la", "basics"],
    ["pwd", "pwd", ""],
  ]);
});

test("combineSnippetImportPayloads combines snippets and packages from multiple files", () => {
  const one = parseSnippetImportPayload(JSON.stringify({
    kind: "netcatty.snippets",
    version: 1,
    exportedAt: "2026-06-23T00:00:00.000Z",
    snippetPackages: ["ops"],
    snippets: [
      { label: "Disk free", command: "df -h", package: "ops" },
    ],
  }));
  const two = parseSnippetImportPayload(JSON.stringify([
    { label: "Docker ps", command: "docker ps", package: "containers" },
  ]));

  const combined = combineSnippetImportPayloads([one, two]);

  assert.deepEqual(combined.snippetPackages, ["ops", "containers"]);
  assert.deepEqual(combined.snippets.map((item) => [item.label, item.command, item.package]), [
    ["Disk free", "df -h", "ops"],
    ["Docker ps", "docker ps", "containers"],
  ]);
});

test("mergeSnippetImportPayload overwrites duplicate commands while preserving local identity", () => {
  const existing = [
    snippet({
      id: "local-1",
      label: "Local uptime",
      command: "uptime",
      package: "",
      targets: ["host-1"],
      order: 1000,
    }),
  ];
  const payload = parseSnippetImportPayload(JSON.stringify({
    kind: "netcatty.snippets",
    version: 1,
    exportedAt: "2026-06-23T00:00:00.000Z",
    snippetPackages: ["ops"],
    snippets: [
      {
        label: "Remote uptime",
        command: "uptime",
        package: "ops",
        tags: ["linux"],
        shortkey: "F8",
        noAutoRun: true,
        multiLineRunMode: "lineDelay",
      },
    ],
  }));

  const result = mergeSnippetImportPayload({
    existingSnippets: existing,
    existingSnippetPackages: [],
    payload,
    conflictAction: "overwrite",
    createId: () => "unused",
  });

  assert.deepEqual(result.stats, {
    imported: 0,
    overwritten: 1,
    skipped: 0,
    conflicts: 1,
  });
  assert.deepEqual(result.snippets, [
    {
      id: "local-1",
      label: "Remote uptime",
      command: "uptime",
      tags: ["linux"],
      package: "ops",
      targets: [],
      shortkey: "F8",
      noAutoRun: true,
      multiLineRunMode: "lineDelay",
      order: 1000,
    },
  ]);
});

test("buildSnippetExportPayload preserves multi-line run mode", () => {
  const payload = buildSnippetExportPayload({
    snippets: [
      snippet({
        id: "snippet-1",
        label: "Prompt login",
        command: "user\npass",
        multiLineRunMode: "lineDelay",
      }),
    ],
    snippetPackages: [],
    exportedAt: "2026-06-23T00:00:00.000Z",
  });

  assert.equal(payload.snippets[0].multiLineRunMode, "lineDelay");
});

test("snippet export and import preserve dynamic group scope", () => {
  const exported = buildSnippetExportPayload({
    snippets: [
      snippet({
        id: "script-1",
        label: "Watch production",
        command: "nct.log('matched')",
        kind: "script",
        trigger: "onOutput",
        triggerPattern: "ERROR",
        targetGroups: ["Production", "Production/Web"],
      }),
    ],
    snippetPackages: [],
    exportedAt: "2026-08-11T00:00:00.000Z",
  });
  const parsed = parseSnippetImportPayload(JSON.stringify(exported));
  const result = mergeSnippetImportPayload({
    existingSnippets: [],
    existingSnippetPackages: [],
    payload: parsed,
    conflictAction: "skip",
    createId: () => "imported-script",
  });

  assert.deepEqual(parsed.snippets[0].targetGroups, ["Production", "Production/Web"]);
  assert.deepEqual(result.snippets[0].targetGroups, ["Production", "Production/Web"]);
  assert.equal(result.snippets[0].trigger, "onOutput");
});

test("snippet export and import preserve an explicitly empty dynamic group scope", () => {
  const exported = buildSnippetExportPayload({
    snippets: [snippet({
      id: "disabled-scope",
      label: "Disabled scope",
      kind: "script",
      trigger: "onOutput",
      triggerPattern: "ERROR",
      targetGroups: [],
      command: "nct.log('disabled-scope')",
    })],
    snippetPackages: [],
  });
  const parsed = parseSnippetImportPayload(JSON.stringify(exported));
  const result = mergeSnippetImportPayload({
    existingSnippets: [],
    existingSnippetPackages: [],
    payload: parsed,
    conflictAction: "skip",
    createId: () => "imported-disabled-scope",
  });

  assert.deepEqual(exported.snippets[0].targetGroups, []);
  assert.deepEqual(parsed.snippets[0].targetGroups, []);
  assert.deepEqual(result.snippets[0].targetGroups, []);
});

test("snippet import normalizes dynamic group paths", () => {
  const parsed = parseSnippetImportPayload(JSON.stringify([{
    label: "Imported group scope",
    command: "nct.log('normalize-groups')",
    kind: "script",
    targetGroups: [" Production\\\\Web ", "Production//Web"],
  }]));
  assert.deepEqual(parsed.snippets[0].targetGroups, ["Production/Web"]);
});

test("mergeSnippetImportPayload keeps existing empty snippet packages", () => {
  const payload = parseSnippetImportPayload(JSON.stringify({
    kind: "netcatty.snippets",
    version: 1,
    exportedAt: "2026-06-23T00:00:00.000Z",
    snippetPackages: ["imported/ops"],
    snippets: [
      { label: "Disk free", command: "df -h", package: "imported/ops" },
    ],
  }));

  const result = mergeSnippetImportPayload({
    existingSnippets: [],
    existingSnippetPackages: ["local-empty"],
    payload,
    conflictAction: "skip",
    createId: () => "new-1",
  });

  assert.deepEqual(result.snippetPackages, ["local-empty", "imported", "imported/ops"]);
});

test("snippet export and import preserve the all-hosts scope", () => {
  const exported = buildSnippetExportPayload({
    snippets: [
      snippet({
        id: "all-hosts",
        label: "Patch everything",
        command: "apt-get update",
        targetsAllHosts: true,
      }),
    ],
    snippetPackages: [],
    exportedAt: "2026-10-11T00:00:00.000Z",
  });

  // New exports carry the all-hosts scope, so they must advertise a version
  // that pre-change releases do not silently accept while dropping the field.
  assert.equal(exported.version, 3);
  const parsed = parseSnippetImportPayload(JSON.stringify(exported));
  const result = mergeSnippetImportPayload({
    existingSnippets: [],
    existingSnippetPackages: [],
    payload: parsed,
    conflictAction: "skip",
    createId: () => "imported-all-hosts",
  });

  assert.equal(exported.snippets[0].targetsAllHosts, true);
  assert.equal("targets" in exported.snippets[0], false);
  assert.equal(parsed.snippets[0].targetsAllHosts, true);
  assert.equal(result.snippets[0].targetsAllHosts, true);
  assert.deepEqual(result.snippets[0].targets, []);
  assert.equal(result.snippets[0].targetGroups, undefined);
});

test("snippet import resolves all-hosts scope against dynamic groups", () => {
  const parsed = parseSnippetImportPayload(JSON.stringify({
    kind: "netcatty.snippets",
    version: 2,
    exportedAt: "2026-10-11T00:00:00.000Z",
    snippetPackages: [],
    snippets: [
      {
        label: "All hosts beats groups",
        command: "uptime",
        targetGroups: ["Production"],
        targetsAllHosts: true,
      },
      {
        label: "Explicit false stays unscoped",
        command: "whoami",
        targetsAllHosts: false,
      },
    ],
  }));

  assert.equal(parsed.snippets[0].targetsAllHosts, true);
  assert.equal(parsed.snippets[0].targetGroups, undefined);
  assert.deepEqual(parsed.snippets[0].targetGroups ?? [], []);
  assert.deepEqual([...(parsed.snippets[0].tags ?? [])], []);
  assert.equal(parsed.snippets[1].targetsAllHosts, undefined);
  const merged = mergeSnippetImportPayload({
    existingSnippets: [],
    existingSnippetPackages: [],
    payload: parsed,
    conflictAction: "skip",
    createId: () => "import-1",
  });
  assert.equal(merged.snippets[0].targetsAllHosts, true);
  assert.deepEqual(merged.snippets[0].targetGroups, undefined);
  assert.equal(merged.snippets[1].targetsAllHosts, undefined);
  assert.deepEqual(merged.snippets[1].targetGroups, undefined);
});
