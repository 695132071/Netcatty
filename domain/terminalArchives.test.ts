import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";

import type { Host } from "./models";
import {
  buildArchiveExtractCommand,
  findTerminalArchiveTokens,
  resolveArchivePath,
  supportsTerminalArchiveCommands,
} from "./terminalArchives.ts";

const host = {
  id: "test",
  label: "Test",
  hostname: "host",
  username: "me",
  tags: [],
  os: "linux",
} as Host;

function commandFor(printed: string, cwd: string | null = "/work"): string | null {
  const token = findTerminalArchiveTokens(printed)[0];
  if (!token) return null;
  const abs = resolveArchivePath(token.path, cwd);
  if (!abs) return null;
  return buildArchiveExtractCommand(abs);
}

function splitShell(shell: "sh" | "fish", command: string): string[] | null {
  if (shell === "fish") {
    const probe = spawnSync("fish", ["-c", "true"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) return null;
    const out = execFileSync(
      "fish",
      ["-c", `set argv ${command}; printf '%s\\0' $argv`],
      { encoding: "utf8" },
    );
    return out.split("\0").slice(0, -1);
  }
  const out = execFileSync(
    "/bin/sh",
    ["-c", `set -- ${command}; printf '%s\\0' "$@"`],
    { encoding: "utf8" },
  );
  return out.split("\0").slice(0, -1);
}

test("Linux archive commands exclude Windows, WSL, macOS, and non-shell protocols", () => {
  assert.equal(supportsTerminalArchiveCommands(host, "darwin"), false);
  assert.equal(supportsTerminalArchiveCommands(host, "win32"), false);
  assert.equal(supportsTerminalArchiveCommands({ ...host, distro: "ubuntu" }, "darwin"), true);
  assert.equal(supportsTerminalArchiveCommands({ ...host, osOverride: "linux" }, "darwin"), true);
  for (const osOverride of ["unknown", "windows", "macos", "freebsd"] as const) {
    assert.equal(
      supportsTerminalArchiveCommands({ ...host, osOverride, distro: "ubuntu" }, "linux"),
      false,
    );
  }
  assert.equal(
    supportsTerminalArchiveCommands({ ...host, distro: "ubuntu", deviceType: "network" }, "linux"),
    false,
  );
  for (const protocol of ["telnet", "serial", "plugin:test"] as const) {
    assert.equal(
      supportsTerminalArchiveCommands({ ...host, protocol, osOverride: "linux" }, "linux"),
      false,
    );
  }
  assert.equal(supportsTerminalArchiveCommands({ ...host, protocol: "local" }, "darwin"), false);
  assert.equal(supportsTerminalArchiveCommands({ ...host, protocol: "local" }, "win32"), false);
  assert.equal(supportsTerminalArchiveCommands({ ...host, protocol: "local", os: "linux" }, "linux"), true);
});

test("each agreed suffix maps to the right extraction command, including upper case", () => {
  const cases: Array<[string, string]> = [
    ["a.tar", "tar -xvf '/work/a.tar' -C '/work'"],
    ["b.tar.gz", "tar -xvzf '/work/b.tar.gz' -C '/work'"],
    ["c.tgz", "tar -xvzf '/work/c.tgz' -C '/work'"],
    ["d.tar.bz2", "tar -xvjf '/work/d.tar.bz2' -C '/work'"],
    ["e.tbz2", "tar -xvjf '/work/e.tbz2' -C '/work'"],
    ["f.tar.xz", "tar -xvJf '/work/f.tar.xz' -C '/work'"],
    ["h.zip", "unzip '/work/h.zip' -d '/work'"],
    ["A.TAR", "tar -xvf '/work/A.TAR' -C '/work'"],
    ["B.TAR.GZ", "tar -xvzf '/work/B.TAR.GZ' -C '/work'"],
    ["C.TGZ", "tar -xvzf '/work/C.TGZ' -C '/work'"],
    ["D.TAR.BZ2", "tar -xvjf '/work/D.TAR.BZ2' -C '/work'"],
    ["E.TBZ2", "tar -xvjf '/work/E.TBZ2' -C '/work'"],
    ["F.TAR.XZ", "tar -xvJf '/work/F.TAR.XZ' -C '/work'"],
    ["H.ZIP", "unzip '/work/H.ZIP' -d '/work'"],
  ];
  for (const [name, expected] of cases) {
    assert.equal(commandFor(name), expected, name);
    assert.equal(/[\r\n]/u.test(expected), false);
  }
  for (const name of ["a.gz", "b.rar", "c.7z", "d.txz", "tool.exe", ".tar", ".zip", ".tar.gz"]) {
    assert.deepEqual(findTerminalArchiveTokens(name), [], name);
  }
});

test("quoted, Unicode, and command-substitution names stay one literal argument", () => {
  const line = `"it's $(touch NO).tar.gz" 'my file.tar.gz' 文件.tar "it's.zip"`;
  const tokens = findTerminalArchiveTokens(line);
  assert.deepEqual(tokens.map((token) => token.path), [
    "it's $(touch NO).tar.gz",
    "my file.tar.gz",
    "文件.tar",
    "it's.zip",
  ]);
  for (const token of tokens) {
    assert.equal(line.slice(token.start, token.start + token.length), token.text);
    const abs = resolveArchivePath(token.path, "/opt");
    assert.ok(abs);
    const command = buildArchiveExtractCommand(abs);
    assert.ok(command);
    assert.equal(/[\r\n]/u.test(command), false);
    for (const shell of ["sh", "fish"] as const) {
      const words = splitShell(shell, command);
      if (!words) continue;
      assert.ok(words.includes(abs), `${shell} ${command}`);
      assert.equal(words.filter((word) => word === abs).length, 1);
    }
  }
  const escaped = findTerminalArchiveTokens(String.raw`my\ file.tar.gz`);
  assert.equal(escaped.length, 1);
  assert.equal(escaped[0]?.path, "my file.tar.gz");
  assert.equal(escaped[0]?.text, String.raw`my\ file.tar.gz`);
});

test("rejects home, urls, control characters, backslashes, history, zip globs, and open quotes", () => {
  for (const printed of [
    "~/a.tar.gz",
    "~user/a.tar",
    "http://example.com/a.zip",
    "user@h:/a.tar",
    "file\u001b.tar.gz",
    String.raw`fish\name.tar.gz`,
    "'fish\\name.tar.gz'",
    "hist!.tar.gz",
    "a*.zip",
    "a?.zip",
    "a[.zip",
    '"unfinished.tar.gz',
  ]) {
    assert.deepEqual(findTerminalArchiveTokens(printed), [], printed);
  }
  assert.equal(findTerminalArchiveTokens("a*.tar.gz").length, 1);
  assert.equal(findTerminalArchiveTokens("“pack.zip”")[0]?.path, "pack.zip");
  assert.equal(findTerminalArchiveTokens("‘a.tar’")[0]?.path, "a.tar");
});

test("resolveArchivePath normalizes against the interval cwd and keeps absolute paths", () => {
  assert.equal(resolveArchivePath("sub/../a.tar.gz", "/x"), "/x/a.tar.gz");
  assert.equal(resolveArchivePath("a.tar.gz", null), null);
  assert.equal(resolveArchivePath("/opt/a.tar.gz", null), "/opt/a.tar.gz");
  assert.equal(resolveArchivePath("/opt/a.tar.gz", "/elsewhere"), "/opt/a.tar.gz");
  assert.equal(buildArchiveExtractCommand("/a.tar"), "tar -xvf '/a.tar' -C '/'");
  assert.equal(
    buildArchiveExtractCommand("/abs/a.zip"),
    "unzip '/abs/a.zip' -d '/abs'",
  );
});
