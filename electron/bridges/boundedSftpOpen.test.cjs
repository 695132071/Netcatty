"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter, getEventListeners } = require("node:events");
const {
  DEFAULT_SFTP_CHANNEL_ABANDON_WAIT_MS,
  openBoundedSftpChannel,
} = require("./boundedSftpOpen.cjs");

function trackedTimerApi() {
  const active = new Set();
  return {
    active,
    setTimeoutFn(callback, delay) {
      let timer;
      timer = setTimeout(() => {
        active.delete(timer);
        callback();
      }, delay);
      active.add(timer);
      return timer;
    },
    clearTimeoutFn(timer) {
      clearTimeout(timer);
      active.delete(timer);
    },
  };
}

function createChannel() {
  const channel = new EventEmitter();
  channel.endCalls = 0;
  channel.closeCalls = 0;
  channel.end = () => { channel.endCalls += 1; };
  channel.close = () => { channel.closeCalls += 1; };
  return channel;
}

test("bounded SFTP open times out and closes a late channel", async () => {
  let callback;
  let invalidations = 0;
  const timers = trackedTimerApi();
  const sshClient = {
    sftp(next) { callback = next; },
    destroy() { invalidations += 1; },
  };
  const result = openBoundedSftpChannel(sshClient, { timeoutMs: 5, ...timers });
  assert.equal(timers.active.size, 1);
  assert.equal([...timers.active][0].hasRef(), true);
  await assert.rejects(result, (error) => error.code === "SFTP_CHANNEL_OPEN_TIMEOUT");
  assert.equal(invalidations, 0, "one channel request must not destroy the shared SSH transport");
  assert.equal(timers.active.size, 0);

  const channel = createChannel();
  callback(null, channel);
  assert.ok(channel.endCalls > 0 || channel.closeCalls > 0);
  assert.equal(timers.active.size, 0);
});

test("bounded SFTP open cancellation settles immediately and closes a late channel", async () => {
  let callback;
  let invalidations = 0;
  const timers = trackedTimerApi();
  const controller = new AbortController();
  const sshClient = {
    sftp(next) { callback = next; },
    destroy() { invalidations += 1; },
  };
  const result = openBoundedSftpChannel(sshClient, {
    signal: controller.signal,
    ...timers,
  });
  assert.equal(timers.active.size, 1);
  assert.equal([...timers.active][0].hasRef(), true);
  controller.abort(new Error("cancelled"));
  await assert.rejects(result, /cancelled/);
  assert.equal(invalidations, 0, "one channel request must not destroy the shared SSH transport");
  assert.equal(timers.active.size, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);

  const channel = createChannel();
  callback(new Error("late open failure"), channel);
  assert.ok(channel.endCalls > 0 || channel.closeCalls > 0);
  assert.equal(timers.active.size, 0);
});

for (const reason of ["timeout", "cancel"]) {
  test(`abandoned ${reason} opens cannot accumulate requests on a shared transport`, async () => {
    const callbacks = [];
    let physicalCloses = 0;
    const sshClient = new EventEmitter();
    sshClient.sftp = callback => { callbacks.push(callback); };
    sshClient.end = sshClient.destroy = () => { physicalCloses++; };
    const controller = new AbortController();
    const opening = openBoundedSftpChannel(sshClient, { timeoutMs: 5, signal: controller.signal });
    if (reason === "cancel") controller.abort(new Error("cancelled"));
    await assert.rejects(opening);
    for (let attempt = 0; attempt < 3; attempt++) {
      await assert.rejects(
        openBoundedSftpChannel(sshClient, { timeoutMs: 5, abandonWaitMs: 0 }),
        (error) => error.code === "SFTP_CHANNEL_OPEN_PENDING",
      );
    }
    assert.equal(callbacks.length, 1, "a zero abandon wait must not allocate more SSH channel requests");
    assert.equal(physicalCloses, 0, "existing terminal and SFTP channels remain connected");

    const late = createChannel();
    callbacks[0](null, late);
    assert.ok(late.endCalls > 0 || late.closeCalls > 0);
    const next = openBoundedSftpChannel(sshClient, { timeoutMs: 50 });
    assert.equal(callbacks.length, 2, "a settled abandoned request must release admission");
    const healthy = createChannel();
    callbacks[1](null, healthy);
    assert.equal(await next, healthy);
    assert.equal(physicalCloses, 0);
  });
}

test("healthy SFTP channel openings remain parallel", async () => {
  const callbacks = [];
  const sshClient = { sftp(callback) { callbacks.push(callback); } };
  const first = openBoundedSftpChannel(sshClient, { timeoutMs: 50 });
  const second = openBoundedSftpChannel(sshClient, { timeoutMs: 50 });
  assert.equal(callbacks.length, 2);
  const channels = [createChannel(), createChannel()];
  callbacks.forEach((callback, index) => callback(null, channels[index]));
  assert.deepEqual(await Promise.all([first, second]), channels);
});

test("bounded SFTP open removes cancellation listeners after success and failure", async () => {
  for (const outcome of ["success", "error"]) {
    const controller = new AbortController();
    const timers = trackedTimerApi();
    let callback;
    const sshClient = { sftp(next) { callback = next; } };
    const result = openBoundedSftpChannel(sshClient, {
      signal: controller.signal,
      ...timers,
    });
    assert.equal(timers.active.size, 1);
    assert.equal([...timers.active][0].hasRef(), true);
    if (outcome === "success") callback(null, createChannel());
    else callback(new Error("open failed"));
    if (outcome === "success") assert.ok(await result);
    else await assert.rejects(result, /open failed/);
    assert.equal(timers.active.size, 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
});

test("bounded SFTP open converts synchronous setup errors into rejections", async () => {
  const sshClient = { sftp() { throw new Error("sync failure"); } };
  await assert.rejects(openBoundedSftpChannel(sshClient), /sync failure/);
});

test("transport closure releases abandoned-open bookkeeping without a late callback", async () => {
  const sshClient = new EventEmitter();
  const callbacks = [];
  sshClient.sftp = callback => callbacks.push(callback);
  await assert.rejects(openBoundedSftpChannel(sshClient, { timeoutMs: 5 }));
  assert.equal(sshClient.listenerCount("close"), 1);
  sshClient.emit("close");
  assert.equal(sshClient.listenerCount("close"), 0);
  const next = openBoundedSftpChannel(sshClient, { timeoutMs: 50 });
  const channel = createChannel();
  callbacks[1](null, channel);
  assert.equal(await next, channel);
  const late = createChannel();
  callbacks[0](null, late);
  assert.ok(late.endCalls > 0);
});

test("all abandoned parallel opens must settle before admitting a new one", async () => {
  const sshClient = new EventEmitter();
  const callbacks = [];
  sshClient.sftp = callback => callbacks.push(callback);
  const first = openBoundedSftpChannel(sshClient, { timeoutMs: 5 });
  const second = openBoundedSftpChannel(sshClient, { timeoutMs: 5 });
  await Promise.all([assert.rejects(first), assert.rejects(second)]);
  assert.equal(sshClient.listenerCount("close"), 1);
  callbacks[0](new Error("first failed"));
  await assert.rejects(
    openBoundedSftpChannel(sshClient, { abandonWaitMs: 0 }),
    (error) => error.code === "SFTP_CHANNEL_OPEN_PENDING",
  );
  callbacks[1](new Error("second failed"));
  assert.equal(sshClient.listenerCount("close"), 0);
  const next = openBoundedSftpChannel(sshClient);
  callbacks[2](null, createChannel());
  await next;
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function settleOpen(promise) {
  return promise.then((channel) => ({ channel }), (error) => ({ error }));
}

test("abandon wait defaults to 2s", () => {
  assert.equal(DEFAULT_SFTP_CHANNEL_ABANDON_WAIT_MS, 2_000);
});

test("omitted abandon wait does not admit a new open immediately", async () => {
  const callbacks = [];
  const sshClient = new EventEmitter();
  sshClient.sftp = (callback) => { callbacks.push(callback); };
  await assert.rejects(
    openBoundedSftpChannel(sshClient, { timeoutMs: 5 }),
    (error) => error.code === "SFTP_CHANNEL_OPEN_TIMEOUT",
  );
  const outcome = settleOpen(openBoundedSftpChannel(sshClient, { timeoutMs: 50 }));
  await delay(40);
  assert.equal(callbacks.length, 1, "the default abandon wait must still be holding");
  const late = createChannel();
  callbacks[0](null, late);
  assert.ok(late.endCalls > 0 || late.closeCalls > 0);
  await delay(20);
  assert.equal(callbacks.length, 2, "a late callback must release the next open");
  const healthy = createChannel();
  callbacks[1](null, healthy);
  const settled = await outcome;
  assert.equal(settled.channel, healthy);
  assert.equal(settled.error, undefined);
});

test("abandon wait admits a new open when the late callback never arrives", async () => {
  const callbacks = [];
  const sshClient = new EventEmitter();
  sshClient.sftp = (callback) => {
    callbacks.push(callback);
    if (callbacks.length > 1) callback(null, createChannel());
  };
  await assert.rejects(
    openBoundedSftpChannel(sshClient, { timeoutMs: 10, abandonWaitMs: 20 }),
    (error) => error.code === "SFTP_CHANNEL_OPEN_TIMEOUT",
  );
  assert.equal(sshClient.listenerCount("close"), 1);

  let pending = 0;
  let ok = 0;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const channel = await openBoundedSftpChannel(sshClient, {
        timeoutMs: 50,
        abandonWaitMs: 30,
      });
      assert.ok(channel);
      ok += 1;
    } catch (error) {
      if (error?.code === "SFTP_CHANNEL_OPEN_PENDING") pending += 1;
      else throw error;
    }
  }
  assert.equal(ok, 5);
  assert.equal(pending, 0);
  assert.equal(sshClient.listenerCount("close"), 0, "force-clear must drop the close listener");

  const late = createChannel();
  callbacks[0](null, late);
  assert.ok(late.endCalls > 0 || late.closeCalls > 0, "a late channel is still closed");
  assert.equal(sshClient.listenerCount("close"), 0);
});

test("partially settled abandoned opens keep the gate until the rest arrive or the wait expires", async () => {
  const callbacks = [];
  const sshClient = new EventEmitter();
  sshClient.sftp = (callback) => { callbacks.push(callback); };
  const first = openBoundedSftpChannel(sshClient, { timeoutMs: 5, abandonWaitMs: 20 });
  const second = openBoundedSftpChannel(sshClient, { timeoutMs: 5, abandonWaitMs: 20 });
  await Promise.all([assert.rejects(first), assert.rejects(second)]);

  const outcome = settleOpen(openBoundedSftpChannel(sshClient, {
    timeoutMs: 50,
    abandonWaitMs: 250,
  }));
  await delay(30);
  callbacks[0](new Error("first failed"));
  await delay(30);
  assert.equal(callbacks.length, 2, "one remaining abandoned open must keep the gate");
  callbacks[1](new Error("second failed"));
  await delay(20);
  assert.equal(callbacks.length, 3);
  const healthy = createChannel();
  callbacks[2](null, healthy);
  const settled = await outcome;
  assert.equal(settled.channel, healthy);
});

test("abandon wait force-clears every outstanding token", async () => {
  const callbacks = [];
  let admitted = null;
  const sshClient = new EventEmitter();
  sshClient.sftp = (callback) => {
    callbacks.push(callback);
    if (callbacks.length > 2) {
      admitted = createChannel();
      callback(null, admitted);
    }
  };
  await Promise.all([
    assert.rejects(openBoundedSftpChannel(sshClient, { timeoutMs: 5 })),
    assert.rejects(openBoundedSftpChannel(sshClient, { timeoutMs: 5 })),
  ]);
  const outcome = settleOpen(openBoundedSftpChannel(sshClient, {
    timeoutMs: 50,
    abandonWaitMs: 40,
  }));
  await delay(15);
  assert.equal(callbacks.length, 2);
  const settled = await outcome;
  assert.equal(settled.error, undefined, settled.error?.message);
  assert.equal(settled.channel, admitted);
  assert.equal(admitted.endCalls, 0);
  assert.equal(admitted.closeCalls, 0);
  assert.equal(callbacks.length, 3);
  for (const callback of callbacks.slice(0, 2)) {
    const late = createChannel();
    callback(null, late);
    assert.ok(late.endCalls > 0 || late.closeCalls > 0);
  }
});

test("cancel during the abandon wait does not admit another open or clear the gate", async () => {
  const callbacks = [];
  const sshClient = new EventEmitter();
  sshClient.sftp = (callback) => { callbacks.push(callback); };
  const controller = new AbortController();
  await assert.rejects(openBoundedSftpChannel(sshClient, { timeoutMs: 5 }));
  const outcome = settleOpen(openBoundedSftpChannel(sshClient, {
    timeoutMs: 50,
    abandonWaitMs: 400,
    signal: controller.signal,
  }));
  await delay(20);
  assert.equal(callbacks.length, 1);
  controller.abort(new Error("cancelled"));
  const settled = await outcome;
  assert.match(settled.error?.message || "", /cancelled/);
  assert.equal(callbacks.length, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  await assert.rejects(
    openBoundedSftpChannel(sshClient, { abandonWaitMs: 0 }),
    (error) => error.code === "SFTP_CHANNEL_OPEN_PENDING",
  );
  assert.equal(callbacks.length, 1);
});
