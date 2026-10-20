const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MAX_OPEN_TERMINAL_SHELL_LENGTH,
  collectOpenTerminalPathArgs,
  collectOpenTerminalRequests,
  expandHomePath,
  hasOpenTerminalLaunchArgs,
  normalizeOpenTerminalPathToken,
  resolveOpenTerminalPath,
  resolveOpenTerminalPathsFromArgs,
  resolveOpenTerminalRequestsFromArgs,
  sanitizeOpenTerminalShell,
} = require("./openTerminalPath.cjs");

test("collectOpenTerminalPathArgs extracts explicit open terminal paths", () => {
  assert.deepEqual(
    collectOpenTerminalPathArgs([
      "/Applications/Netcatty.app/Contents/MacOS/Netcatty",
      "--open-terminal-path",
      "/Users/alice/project",
      "--open-terminal-path=/tmp/demo",
      "--ignored",
    ]),
    ["/Users/alice/project", "/tmp/demo"],
  );
});

test("collectOpenTerminalPathArgs accepts Electron-safe -- and equals forms", () => {
  assert.deepEqual(
    collectOpenTerminalPathArgs([
      String.raw`C:\Program Files\Netcatty\Netcatty.exe`,
      "--",
      String.raw`--open-terminal-path=C:\Users\alice\project.`,
    ]),
    [String.raw`C:\Users\alice\project`],
  );
});

test("normalizeOpenTerminalPathToken strips quotes and Windows shell trailing dots", () => {
  assert.equal(
    normalizeOpenTerminalPathToken('"C:\\Users\\alice\\Docs."'),
    "C:\\Users\\alice\\Docs",
  );
  assert.equal(normalizeOpenTerminalPathToken("C:\\"), "C:\\");
});

test("resolveOpenTerminalPath accepts directories", () => {
  const fsModule = {
    statSync: (target) => ({
      target,
      isDirectory: () => true,
      isFile: () => false,
    }),
  };

  assert.equal(
    resolveOpenTerminalPath("/tmp/project", { fsModule, logWarn: () => {} }),
    "/tmp/project",
  );
});

test("resolveOpenTerminalPath resolves relative paths against the provided base directory", () => {
  const seen = [];
  const fsModule = {
    statSync: (target) => {
      seen.push(target);
      return {
        isDirectory: () => true,
        isFile: () => false,
      };
    },
  };

  assert.equal(
    resolveOpenTerminalPath("project", {
      baseDirectory: "/Users/alice",
      fsModule,
      logWarn: () => {},
    }),
    "/Users/alice/project",
  );
  assert.deepEqual(seen, ["/Users/alice/project"]);
});

test("resolveOpenTerminalPathsFromArgs resolves second-instance relative paths against its working directory", () => {
  const fsModule = {
    statSync: () => ({
      isDirectory: () => true,
      isFile: () => false,
    }),
  };

  assert.deepEqual(
    resolveOpenTerminalPathsFromArgs([
      "/Applications/Netcatty.app/Contents/MacOS/Netcatty",
      "--open-terminal-path",
      ".",
    ], {
      baseDirectory: "/Users/alice/project",
      fsModule,
      logWarn: () => {},
    }),
    ["/Users/alice/project"],
  );
});

test("expandHomePath expands home-relative terminal paths", () => {
  assert.equal(
    expandHomePath("~/project", { osHomedir: () => "/Users/alice" }),
    "/Users/alice/project",
  );
  assert.equal(
    expandHomePath("~", { osHomedir: () => "/Users/alice" }),
    "/Users/alice",
  );
});

test("resolveOpenTerminalPath uses parent directory for files", () => {
  const fsModule = {
    statSync: () => ({
      isDirectory: () => false,
      isFile: () => true,
    }),
  };

  assert.equal(
    resolveOpenTerminalPath("/tmp/project/readme.md", { fsModule, logWarn: () => {} }),
    "/tmp/project",
  );
});

function directoryFs() {
  return {
    statSync: () => ({
      isDirectory: () => true,
      isFile: () => false,
    }),
  };
}

test("collectOpenTerminalRequests pairs a shell with a path in either order", () => {
  assert.deepEqual(
    collectOpenTerminalRequests([
      "Netcatty.exe",
      "--",
      "--open-terminal-shell=pwsh",
      "--open-terminal-path",
      String.raw`D:\proj`,
    ]),
    [{ shell: "pwsh", path: String.raw`D:\proj` }],
  );
  assert.deepEqual(
    collectOpenTerminalRequests([
      "--open-terminal-path=/tmp/demo",
      "--open-terminal-shell",
      "/usr/local/bin/fish",
    ]),
    [{ path: "/tmp/demo", shell: "/usr/local/bin/fish" }],
  );
});

test("collectOpenTerminalRequests opens on a shell flag alone and keeps path-only requests", () => {
  assert.deepEqual(
    collectOpenTerminalRequests(["--open-terminal-shell", "wsl-ubuntu"]),
    [{ shell: "wsl-ubuntu" }],
  );
  assert.deepEqual(
    collectOpenTerminalRequests(["--open-terminal-path", "/tmp/demo"]),
    [{ path: "/tmp/demo" }],
  );
});

test("collectOpenTerminalRequests starts a new request when a flag repeats", () => {
  assert.deepEqual(
    collectOpenTerminalRequests([
      "--open-terminal-shell",
      "pwsh",
      "--open-terminal-path",
      "/tmp/a",
      "--open-terminal-shell",
      "cmd",
      "--open-terminal-path",
      "/tmp/b",
    ]),
    [
      { shell: "pwsh", path: "/tmp/a" },
      { shell: "cmd", path: "/tmp/b" },
    ],
  );
});

test("collectOpenTerminalRequests does not swallow a sibling flag as a value", () => {
  assert.deepEqual(
    collectOpenTerminalRequests([
      "--open-terminal-shell",
      "--open-terminal-path=/tmp/demo",
    ]),
    [{ path: "/tmp/demo" }],
  );
});

test("sanitizeOpenTerminalShell rejects empty, NUL, and over-long values", () => {
  assert.equal(sanitizeOpenTerminalShell("  pwsh  "), "pwsh");
  assert.equal(sanitizeOpenTerminalShell('"pwsh"'), "pwsh");
  assert.equal(sanitizeOpenTerminalShell(""), "");
  assert.equal(sanitizeOpenTerminalShell("   "), "");
  assert.equal(sanitizeOpenTerminalShell("pwsh\0"), "");
  assert.equal(sanitizeOpenTerminalShell(`\0pwsh`), "");
  assert.equal(sanitizeOpenTerminalShell("a".repeat(MAX_OPEN_TERMINAL_SHELL_LENGTH)), "a".repeat(MAX_OPEN_TERMINAL_SHELL_LENGTH));
  assert.equal(sanitizeOpenTerminalShell("a".repeat(MAX_OPEN_TERMINAL_SHELL_LENGTH + 1)), "");
});

test("resolveOpenTerminalRequestsFromArgs keeps a shell-only launch without touching the filesystem", () => {
  assert.deepEqual(
    resolveOpenTerminalRequestsFromArgs(["--open-terminal-shell", "cmd"], {
      fsModule: {
        statSync: () => {
          throw new Error("shell-only must not stat");
        },
      },
      logWarn: () => {},
    }),
    [{ shell: "cmd" }],
  );
});

test("resolveOpenTerminalRequestsFromArgs returns a path-only request unchanged", () => {
  assert.deepEqual(
    resolveOpenTerminalRequestsFromArgs([
      "--open-terminal-path",
      "project",
    ], {
      baseDirectory: "/Users/alice",
      fsModule: directoryFs(),
      logWarn: () => {},
    }),
    [{ path: "/Users/alice/project" }],
  );
});

test("resolveOpenTerminalRequestsFromArgs pairs a resolved directory with the shell", () => {
  assert.deepEqual(
    resolveOpenTerminalRequestsFromArgs([
      "--open-terminal-shell=pwsh",
      "--open-terminal-path",
      "project",
    ], {
      baseDirectory: "/Users/alice",
      fsModule: directoryFs(),
      logWarn: () => {},
    }),
    [{ shell: "pwsh", path: "/Users/alice/project" }],
  );
});

test("resolveOpenTerminalRequestsFromArgs drops a paired shell when the path is invalid", () => {
  assert.deepEqual(
    resolveOpenTerminalRequestsFromArgs([
      "--open-terminal-shell",
      "pwsh",
      "--open-terminal-path",
      "/tmp/missing",
    ], {
      fsModule: {
        statSync: () => {
          throw new Error("missing");
        },
      },
      logWarn: () => {},
    }),
    [],
  );
});

test("resolveOpenTerminalRequestsFromArgs keeps a valid path when the shell fails the sanity check", () => {
  assert.deepEqual(
    resolveOpenTerminalRequestsFromArgs([
      "--open-terminal-path",
      "/tmp/project",
      "--open-terminal-shell",
      "pwsh\0",
    ], {
      fsModule: directoryFs(),
      logWarn: () => {},
    }),
    [{ path: "/tmp/project" }],
  );
});

test("hasOpenTerminalLaunchArgs is true for either flag and false for an empty value", () => {
  assert.equal(hasOpenTerminalLaunchArgs(["--open-terminal-shell", "pwsh"]), true);
  assert.equal(hasOpenTerminalLaunchArgs(["--open-terminal-path=/tmp/demo"]), true);
  assert.equal(hasOpenTerminalLaunchArgs(["--open-terminal-shell", "bad\0shell"]), true);
  assert.equal(hasOpenTerminalLaunchArgs(["--open-terminal-shell="]), false);
  assert.equal(hasOpenTerminalLaunchArgs(["--open-terminal-path"]), false);
  assert.equal(hasOpenTerminalLaunchArgs(["--other"]), false);
});

test("resolveOpenTerminalPath rejects missing paths", () => {
  const warnings = [];
  const fsModule = {
    statSync: () => {
      throw new Error("missing");
    },
  };

  assert.equal(
    resolveOpenTerminalPath("/tmp/missing", {
      fsModule,
      logWarn: (...args) => warnings.push(args),
    }),
    null,
  );
  assert.equal(warnings.length, 1);
});
