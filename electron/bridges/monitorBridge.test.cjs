const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const pool = require("./sshConnectionPool.cjs");
const { createMonitorService } = require("./monitorBridge.cjs");
const {
  sampleSharedStats,
  readSharedStats,
  cancelSharedStats,
  resetSharedStatsForTests,
} = require("./sshBridge/sharedStats.cjs");
const event = (id) => ({ sender: { id } });
const options = {
  hostId: "h",
  hostname: "test",
  username: "alice",
  password: "fixture-password",
  verifyHostKeys: true,
};
const demand = (id = "p", opts = options) => ({
  id,
  interval: 10,
  hosts: [{ id: "h", options: opts }],
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(predicate(), "asynchronous monitor state did not settle");
}
function conn() {
  const c = new EventEmitter();
  c._sock = { destroyed: false };
  c.end = () => {
    c.ended = true;
  };
  return c;
}
function fixture(overrides = {}) {
  let dials = 0,
    samples = 0;
  const timers = [];
  const c = conn();
  const service = createMonitorService({
    startConnection: async (_e, opts) => {
      dials++;
      return {
        transport: pool.createTransport({
          conn: c,
          endpoint: pool.buildConnectionReuseEndpoint(opts),
        }),
      };
    },
    cancelConnection: () => {},
    getStats: (context) =>
      sampleSharedStats(context, async () => {
        samples++;
        return {
          success: true,
          stats: {
            cpu: null,
            memTotal: 100,
            memUsed: 50,
            networkReady: false,
            disks: [],
          },
        };
      }),
    timers: {
      setTimeout(fn, ms) {
        const t = { fn, ms };
        timers.push(t);
        return t;
      },
      clearTimeout(t) {
        t.cancelled = true;
      },
    },
    ...overrides,
  });
  return {
    service,
    c,
    timers,
    get dials() {
      return dials;
    },
    get samples() {
      return samples;
    },
  };
}
test.beforeEach(() => {
  resetSharedStatsForTests();
  pool.resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
});
test.afterEach(() => pool.resetSshTransportRegistryForTests());
test("two panels and windows share one transport/sample; stopping preserves a terminal lease", async () => {
  const f = fixture();
  f.service.reconcile(event(1), [demand("a"), demand("b")]);
  f.service.reconcile(event(2), [demand("a")]);
  await tick();
  await tick();
  await until(() => f.samples === 1);
  assert.equal(f.dials, 1);
  assert.equal(f.samples, 1);
  assert.equal(f.service.snapshot(event(1)).count, 3);
  const transport = pool.findTransportByEndpoint(
    pool.buildConnectionReuseEndpoint(options),
  );
  const terminal = {};
  pool.borrowTransport(transport, {
    kind: pool.LEASE_KINDS.shell,
    holder: terminal,
  });
  f.service.reconcile(event(1), []);
  assert.equal(f.service.snapshot(event(2)).hostCount, 1);
  f.service.removeOwner(2);
  assert.equal(transport.count, 1);
  assert.equal(f.c.ended, undefined);
  assert.ok(f.timers.every((t) => t.cancelled));
  pool.returnTransport(terminal);
  f.service.dispose();
});
test("different credentials never share an entry or physical dial", async () => {
  const f = fixture();
  f.service.reconcile(event(1), [demand("a")]);
  f.service.reconcile(event(2), [
    demand("b", { ...options, password: "different" }),
  ]);
  await tick();
  await tick();
  await until(() => f.dials === 2);
  assert.equal(f.dials, 2);
  assert.equal(f.service.snapshot(event(1)).hostCount, 2);
  f.service.dispose();
});
test("stopping while queued prevents dial; stopping during dial returns late transport", async () => {
  let finish,
    opens = 0,
    cancels = 0;
  const c = conn();
  const f = fixture({
    startConnection: (_e, opts) => {
      opens++;
      return new Promise((resolve) => {
        finish = () =>
          resolve({
            transport: pool.createTransport({
              conn: c,
              endpoint: pool.buildConnectionReuseEndpoint(opts),
            }),
          });
      });
    },
    cancelConnection: () => cancels++,
  });
  f.service.reconcile(event(1), [demand("a")]);
  await tick();
  f.service.reconcile(event(1), [demand("b", { ...options, username: "bob" })]);
  f.service.reconcile(event(1), []);
  finish();
  await tick();
  await tick();
  assert.equal(opens, 1);
  assert.equal(cancels, 1);
  assert.equal(f.samples, 0);
  assert.equal(f.service.snapshot(event(1)).count, 0);
  const t = pool.findTransportByEndpoint(
    pool.buildConnectionReuseEndpoint(options),
  );
  assert.equal(t.state, "idle");
  assert.equal(t.count, 0);
  f.service.dispose();
});
test("terminal and monitor join in-flight collection; stop never aborts a terminal reader", async () => {
  const c = conn();
  let finish,
    calls = 0,
    aborted = false;
  const collect = (ctx) => {
    calls++;
    ctx.statsSignal.addEventListener("abort", () => (aborted = true));
    if (!ctx._monitorStats)
      return Promise.resolve({
        success: true,
        stats: { cpu: 1, memTotal: 1, memUsed: 1 },
      });
    return new Promise((resolve) => (finish = resolve));
  };
  const a = sampleSharedStats({ conn: c, _monitorStats: true }, collect);
  const b = sampleSharedStats({ conn: c }, collect);
  cancelSharedStats(c);
  assert.equal(aborted, false);
  finish({ success: true, stats: { cpu: null, memTotal: 1, memUsed: 1 } });
  await Promise.all([a, b]);
  assert.equal(calls, 2);
  assert.equal(readSharedStats(c).points.length, 1);
});
test("sparse trends keep a finite time and point budget under sustained samples", async () => {
  const c = conn();
  const original = Date.now;
  let now = 100000;
  Date.now = () => now;
  try {
    for (let i = 0; i < 250; i++) {
      await sampleSharedStats(
        { conn: c, _monitorStats: true },
        async () => ({
          success: true,
          stats: { cpu: i % 100, memTotal: 100, memUsed: 50 },
        }),
        now,
      );
      now += 10000;
    }
    const history = readSharedStats(c).points;
    assert.equal(history.length, 180);
    assert.ok(history.every((p) => now - p.at <= 1800000));
    assert.equal(history[0].at, 800000);
  } finally {
    Date.now = original;
  }
});

test("fresh terminal logins with the exact same pool identity share the monitor's sampler", async () => {
  const a = conn(),
    b = conn();
  const endpoint = pool.normalizeEndpoint(
    pool.buildConnectionReuseEndpoint(options),
  );
  let calls = 0;
  const collect = async () => {
    calls++;
    return { success: true, stats: { cpu: 42, memTotal: 100, memUsed: 50 } };
  };
  await sampleSharedStats(
    { conn: a, _reuseEndpoint: endpoint, _monitorStats: true },
    collect,
  );
  await sampleSharedStats({ conn: b, _reuseEndpoint: endpoint }, collect);
  assert.equal(calls, 2);
  assert.equal(readSharedStats(a).points, readSharedStats(b).points);
});

test("full terminal readers upgrade a lightweight cached sample and keep subsequent queries shared", async () => {
  const c = conn();
  let calls = 0;
  const collect = async (ctx) => {
    calls++;
    return {
      success: true,
      stats: {
        cpu: 42,
        memTotal: 100,
        memUsed: null,
        topProcesses: ctx._monitorStats ? [] : [{ name: "full-process" }],
        gpu: ctx._monitorStats ? null : 75,
      },
    };
  };
  await sampleSharedStats({ conn: c, _monitorStats: true }, collect);
  const terminal = await sampleSharedStats({ conn: c }, collect);
  assert.equal(terminal.stats.topProcesses[0].name, "full-process");
  assert.equal(terminal.stats.gpu, 75);
  assert.equal(calls, 2);
  assert.equal(readSharedStats(c).points[0].memory, null);
  await sampleSharedStats(
    { conn: c, _monitorStats: true },
    collect,
    Date.now() + 5000,
  );
  await sampleSharedStats({ conn: c }, collect);
  assert.equal(calls, 3);
});

test("a failed sample preserves last good measurements, time and sparse history", async () => {
  const c = conn();
  const session = { conn: c, _monitorStats: true };
  await sampleSharedStats(session, async () => ({
    success: true,
    stats: { cpu: 42 },
  }));
  const before = readSharedStats(c);
  const failed = await sampleSharedStats(
    session,
    async () => ({ success: false, error: "timeout" }),
    Date.now() + 5000,
  );
  assert.equal(failed.success, false);
  const after = readSharedStats(c);
  assert.equal(after.at, before.at);
  assert.equal(after.result.stats.cpu, 42);
  assert.deepEqual(after.points, before.points);
});

test("stopping at the post-authentication await cannot orphan a transport lease", async () => {
  let transport;
  const f = fixture({
    startConnection: async (_event, opts) => {
      transport = pool.createTransport({
        conn: conn(),
        endpoint: pool.buildConnectionReuseEndpoint(opts),
      });
      return { transport };
    },
  });
  f.service.reconcile(event(1), [demand()]);
  while (!transport) await Promise.resolve();
  await Promise.resolve();
  f.service.reconcile(event(1), []);
  await tick();
  await tick();
  assert.equal(transport.count, 0);
  assert.equal(f.service.snapshot(event(1)).hostCount, 0);
  f.service.dispose();
});

test("credential-changing retry leaves the other window's original identity actionable", async () => {
  const f = fixture({
    startConnection: async (_event, opts) => {
      if (opts.password !== "corrected") throw new Error("login failed");
      return {
        transport: pool.createTransport({
          conn: conn(),
          endpoint: pool.buildConnectionReuseEndpoint(opts),
        }),
      };
    },
  });
  f.service.reconcile(event(1), [demand()]);
  f.service.reconcile(event(2), [demand()]);
  await tick();
  assert.equal(f.service.snapshot(event(2)).hosts.h.status, "login");
  f.service.retry(event(1), "h");
  f.service.reconcile(event(1), [
    demand("p", { ...options, password: "corrected" }),
  ]);
  await tick();
  await tick();
  await until(() => f.service.snapshot(event(1)).hosts.h.status === "live");
  assert.equal(f.service.snapshot(event(1)).hosts.h.status, "live");
  assert.equal(f.service.snapshot(event(2)).hosts.h.status, "login");
  assert.equal(f.service.snapshot(event(2)).activeSessions.length, 1);
  f.service.retry(event(2), "h");
  f.service.reconcile(event(2), [
    demand("p", { ...options, password: "corrected" }),
  ]);
  await tick();
  await until(() => f.service.snapshot(event(2)).hosts.h.status === "live");
  assert.equal(f.service.snapshot(event(2)).hosts.h.status, "live");
  f.service.dispose();
});

test("same-identity retry restarts shared failed demand for both windows", async () => {
  let attempts = 0;
  const f = fixture({
    startConnection: async (_event, opts) => {
      if (++attempts === 1) throw new Error("login failed");
      return {
        transport: pool.createTransport({
          conn: conn(),
          endpoint: pool.buildConnectionReuseEndpoint(opts),
        }),
      };
    },
  });
  f.service.reconcile(event(1), [demand()]);
  f.service.reconcile(event(2), [demand()]);
  await tick();
  f.service.retry(event(1), "h");
  f.service.reconcile(event(1), [demand()]);
  await tick();
  await tick();
  await until(() => f.service.snapshot(event(1)).hosts.h.status === "live");
  assert.equal(f.service.snapshot(event(1)).hosts.h.status, "live");
  await until(() => f.service.snapshot(event(2)).hosts.h.status === "live");
  assert.equal(f.service.snapshot(event(2)).hosts.h.status, "live");
  await until(() => attempts === 2);
  assert.equal(attempts, 2);
  f.service.dispose();
});

test("closing the owner during authentication reconnects demand for the surviving window", async () => {
  let rejectFirst,
    attempts = 0;
  const f = fixture({
    startConnection: (_event, opts) => {
      if (++attempts === 1)
        return new Promise((_resolve, reject) => {
          rejectFirst = reject;
        });
      return Promise.resolve({
        transport: pool.createTransport({
          conn: conn(),
          endpoint: pool.buildConnectionReuseEndpoint(opts),
        }),
      });
    },
    cancelConnection: () => rejectFirst(new Error("cancelled")),
  });
  f.service.reconcile(event(1), [demand()]);
  f.service.reconcile(event(2), [demand()]);
  await tick();
  f.service.removeOwner(1);
  await tick();
  await tick();
  await until(() => attempts === 2);
  assert.equal(attempts, 2);
  await until(() => f.service.snapshot(event(2)).hosts.h.status === "live");
  assert.equal(f.service.snapshot(event(2)).hosts.h.status, "live");
  f.service.dispose();
});

test("replacing a host at the capacity limit admits its replacement immediately", async () => {
  const f = fixture();
  const hosts = Array.from({ length: 257 }, (_, i) => ({
    id: `h${i}`,
    options: { ...options, hostname: `test-${i}` },
  }));
  f.service.reconcile(event(1), [{ id: "p", hosts: hosts.slice(0, 256) }]);
  f.service.reconcile(event(1), [{ id: "p", hosts: hosts.slice(1) }]);
  const result = f.service.snapshot(event(1));
  assert.equal(result.hostCount, 256);
  assert.equal(result.hosts.h256.status, "queued");
  f.service.dispose();
});

test("closing a window also moves queued shared authentication to the surviving window", async () => {
  let rejectFirst;
  const dials = [];
  const f = fixture({
    startConnection: (e, opts) => {
      dials.push({ owner: e.sender.id, hostname: opts.hostname });
      if (opts.hostname === "first")
        return new Promise((_resolve, reject) => {
          rejectFirst = reject;
        });
      return Promise.resolve({
        transport: pool.createTransport({
          conn: conn(),
          endpoint: pool.buildConnectionReuseEndpoint(opts),
        }),
      });
    },
    cancelConnection: () => rejectFirst?.(new Error("cancelled")),
  });
  const second = { id: "second", options: { ...options, hostname: "second" } };
  f.service.reconcile(event(1), [
    {
      id: "p",
      hosts: [
        { id: "first", options: { ...options, hostname: "first" } },
        second,
      ],
    },
  ]);
  f.service.reconcile(event(2), [{ id: "p", hosts: [second] }]);
  await tick();
  f.service.removeOwner(1);
  await tick();
  await tick();
  assert.deepEqual(dials, [
    { owner: 1, hostname: "first" },
    { owner: 2, hostname: "second" },
  ]);
  await until(
    () => f.service.snapshot(event(2)).hosts.second.status === "live",
  );
  assert.equal(f.service.snapshot(event(2)).hosts.second.status, "live");
  f.service.dispose();
});

test("existing terminal connections sample while an unrelated host awaits authentication", async () => {
  const c = conn();
  const existing = pool.createTransport({
    conn: c,
    endpoint: pool.buildConnectionReuseEndpoint(options),
  });
  const terminal = {};
  pool.borrowTransport(existing, {
    kind: pool.LEASE_KINDS.shell,
    holder: terminal,
  });
  let rejectDial;
  const f = fixture({
    startConnection: () =>
      new Promise((_resolve, reject) => {
        rejectDial = reject;
      }),
    cancelConnection: () => rejectDial(new Error("cancelled")),
  });
  f.service.reconcile(event(1), [
    {
      id: "p",
      hosts: [
        { id: "pending", options: { ...options, hostname: "pending" } },
        { id: "existing", options },
      ],
    },
  ]);
  await tick();
  await tick();
  assert.equal(f.service.snapshot(event(1)).hosts.pending.status, "connecting");
  await until(
    () => f.service.snapshot(event(1)).hosts.existing.status === "live",
  );
  assert.equal(f.service.snapshot(event(1)).hosts.existing.status, "live");
  assert.equal(f.samples, 1);
  f.service.dispose();
  pool.returnTransport(terminal);
});

for (const sharedHost of ["first", "second"]) {
  test(`stopping the original owner transfers ${sharedHost === "first" ? "active" : "queued"} shared authentication`, async () => {
    let rejectFirst;
    const dials = [];
    const f = fixture({
      startConnection: (e, opts) => {
        dials.push({ owner: e.sender.id, hostname: opts.hostname });
        if (dials.length === 1)
          return new Promise((_resolve, reject) => {
            rejectFirst = reject;
          });
        return Promise.resolve({
          transport: pool.createTransport({
            conn: conn(),
            endpoint: pool.buildConnectionReuseEndpoint(opts),
          }),
        });
      },
      cancelConnection: () => rejectFirst?.(new Error("cancelled")),
    });
    const hosts = ["first", "second"].map((hostname) => ({
      id: hostname,
      options: { ...options, hostname },
    }));
    f.service.reconcile(event(1), [{ id: "p", hosts }]);
    f.service.reconcile(event(2), [
      { id: "p", hosts: hosts.filter((h) => h.id === sharedHost) },
    ]);
    await tick();
    f.service.reconcile(event(1), []);
    await tick();
    await tick();
    assert.deepEqual(dials, [
      { owner: 1, hostname: "first" },
      { owner: 2, hostname: sharedHost },
    ]);
    await until(
      () => f.service.snapshot(event(2)).hosts[sharedHost].status === "live",
    );
    assert.equal(f.service.snapshot(event(2)).hosts[sharedHost].status, "live");
    assert.equal(f.service.snapshot(event(1)).activeSessions.length, 0);
    f.service.dispose();
  });
}
