'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSessionOpsApi } = require('./sessionOps.cjs');

for (const method of ['getSessionDistroInfo', 'readRemoteHistory', 'getSessionPwd', 'listSessionDir']) {
  test(`${method} timeout cannot disconnect the terminal or accumulate pending opens`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let callback;
    let opens = 0;
    let destroys = 0;
    const conn = {
      exec(_command, next) { opens++; callback = next; },
      end() { destroys++; },
      destroy() { destroys++; },
    };
    const api = createSessionOpsApi({
      sessions: new Map([['ssh', { type: 'ssh', conn, shellPid: '4242' }]]),
      log() {},
      quoteShellArg: value => "'" + String(value).replace(/'/g, "'\\''") + "'",
      setTimeout, clearTimeout, Buffer,
    });
    const request = api[method]({}, { sessionId: 'ssh', path: '/tmp', limit: 5 });
    assert.equal(opens, 1);
    t.mock.timers.tick(10_000);
    assert.equal((await request).success, false);
    assert.equal(destroys, 0);
    assert.equal((await api[method]({}, { sessionId: 'ssh', path: '/tmp', limit: 5 })).success, false);
    assert.equal(opens, 1);
    const late = new EventEmitter();
    let closed = 0;
    late.close = () => { closed++; };
    callback(null, late);
    assert.equal(closed, 1);
    assert.equal(destroys, 0);
  });
}

for (const method of ['getSessionDistroInfo', 'readRemoteHistory', 'getServerStats']) {
  test(`${method} still tears down an unresponsive dedicated companion`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let destroys = 0;
    const conn = { exec() {}, destroy() { destroys++; } };
    const api = createSessionOpsApi({
      sessions: new Map([['mosh', { type: 'mosh', moshStatsConn: conn }]]),
      quoteShellArg: value => "'" + String(value).replace(/'/g, "'\\''") + "'",
      setTimeout, clearTimeout, Buffer, log() {},
    });
    const request = api[method]({}, { sessionId: 'mosh', limit: 5 });
    t.mock.timers.tick(10_000);
    assert.equal((await request).success, false);
    assert.equal(destroys, 1);
  });
}
