'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const bridge = require('./transferBridge.cjs');
const tempDirBridge = require('./tempDirBridge.cjs');

for (const scenario of ['truncated', 'oversized', 'end', 'close', 'complete']) {
  test(`non-resumable fastGet handles ${scenario} without a false completion or hang`, async t => {
    const id = `integrity-${randomUUID()}`;
    const targetPath = tempDirBridge.getTempFilePath(`${id}.bin`);
    t.after(() => fs.rm(targetPath, { force: true }));
    const channel = new EventEmitter();
    channel.end = () => {};
    channel.fastGet = (_remote, local, _options, done) => {
      if (scenario === 'end' || scenario === 'close') {
        queueMicrotask(() => channel.emit(scenario));
      } else {
        const bytes = scenario === 'truncated' ? 'ab' : scenario === 'oversized' ? 'abcdef' : 'abcd';
        fs.writeFile(local, bytes).then(() => done(), done);
      }
    };
    const sftp = new EventEmitter();
    sftp.readdir = (_path, callback) => callback(null, []);
    sftp.stat = (_path, callback) => callback(null, { size: 4 });
    sftp.mkdir = (_path, callback) => callback(null);
    sftp.unlink = (_path, callback) => callback(null);
    for (const method of ['readdir', 'stat', 'mkdir', 'unlink']) channel[method] = sftp[method];
    const client = { sftp, stat: async () => ({ size: 4 }), client: {
      sftp(callback) { callback(null, channel); },
    } };
    bridge.init({ sftpClients: new Map([['source', client]]) });
    const events = [];
    let timer;
    const running = bridge.startTransfer({ sender: { send: (event, data) => events.push({ event, data }) } }, {
      transferId: id, sourceType: 'sftp', targetType: 'local', sourceSftpId: 'source',
      sourcePath: '/file.bin', targetPath, totalBytes: 4, resumable: false,
    });
    t.after(async () => { clearTimeout(timer); await bridge.cancelTransfer({}, { transferId: id }); await running; });
    const response = await Promise.race([running, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('download did not settle')), 1000);
    })]);
    if (scenario === 'complete') {
      assert.equal(response.error, undefined);
      assert.equal(await fs.readFile(targetPath, 'utf8'), 'abcd');
      assert.ok(events.some(({ event }) => event === 'netcatty:transfer:complete'));
    } else {
      assert.match(response.error, scenario === 'truncated' || scenario === 'oversized'
        ? /size mismatch/ : /channel closed/);
      assert.ok(!events.some(({ event }) => event === 'netcatty:transfer:complete'));
    }
    assert.equal(channel.listenerCount('end'), 0);
    assert.equal(channel.listenerCount('close'), 0);
  });
}
