"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const transferBridge = require("./transferBridge.cjs");
const tempDirBridge = require("./tempDirBridge.cjs");

async function downloadFromSequentialPeer(t, corruptVerification = false) {
  const payload = crypto.randomBytes(3 * 32768 + 17);
  const rewritten = Buffer.from(payload);
  rewritten[40000] ^= 0xff;
  const target = tempDirBridge.getTempFilePath(`term-sshd-${crypto.randomUUID()}.bin`);
  const transferId = crypto.randomUUID();
  const staged = tempDirBridge.getTransferTempFilePath(transferId, path.basename(target));
  t.after(async () => {
    await fs.rm(target, { force: true });
    await fs.rm(staged, { force: true });
  });
  const cursors = new Map();
  let opens = 0;
  let reads = 0;
  let active = 0;
  let maxActive = 0;
  const sftp = new EventEmitter();
  Object.assign(sftp, {
    _client: { _remoteVer: "TERM-SSHD" },
    readdir(_p, callback) { callback(null, []); },
    stat(_p, callback) { callback(null, { size: payload.length, mtime: 1 }); },
    mkdir(_p, callback) { callback(null); },
    unlink(_p, callback) { callback(null); },
    open(_p, _flags, callback) {
      if (cursors.size) return callback(new Error("General failure: one open handle per channel"));
      const handle = Buffer.from(String(++opens));
      cursors.set(handle, 0);
      callback(null, handle);
    },
    read(handle, buffer, offset, length, _position, callback) {
      // Reproduce TERM-SSHD: READ position is ignored; each handle advances.
      const cursor = cursors.get(handle);
      const source = corruptVerification && Number(handle.toString()) >= 2 ? rewritten : payload;
      const count = Math.min(length, source.length - cursor);
      source.copy(buffer, offset, cursor, cursor + count);
      cursors.set(handle, cursor + count);
      reads += count;
      maxActive = Math.max(maxActive, ++active);
      setImmediate(() => { active--; callback(null, count); });
    },
    close(handle, callback) { cursors.delete(handle); callback(null); },
    end() {},
  });
  const client = {
    sftp, __netcattySingleChannelSsh: true,
    stat: async () => ({ size: payload.length, mtime: 1 }),
    client: { _remoteVer: "TERM-SSHD", sftp() { throw new Error("No terminal subsystem reuse"); } },
  };
  transferBridge.init({ sftpClients: new Map([["sequential", client]]) });
  const result = await transferBridge.startTransfer({ sender: { send() {} } }, {
    transferId, sourcePath: "/source.bin", targetPath: target,
    sourceType: "sftp", targetType: "local", sourceSftpId: "sequential",
    totalBytes: payload.length, resumable: true,
  });
  return { result, target, payload, opens, reads, maxActive };
}

test("TERM-SSHD download reopens and verifies the complete file without seeking", async (t) => {
  const actual = await downloadFromSequentialPeer(t);
  assert.equal(actual.result.error, undefined);
  assert.deepEqual(await fs.readFile(actual.target), actual.payload);
  assert.ok(actual.opens >= 2, "verification must use a fresh handle");
  assert.ok(actual.reads >= 2 * actual.payload.length, "verify the full file, not just samples");
  assert.equal(actual.maxActive, 1);
});

test("TERM-SSHD full verification rejects changed bytes and never publishes the destination", async (t) => {
  const actual = await downloadFromSequentialPeer(t, true);
  assert.match(actual.result.error || "", /source.*changed/i);
  await assert.rejects(fs.stat(actual.target), { code: "ENOENT" });
});

for (const corrupt of [false, true]) {
  test(`TERM-SSHD uploads verify remote content before promotion (corrupt=${corrupt})`, async (t) => {
    const payload = crypto.randomBytes(3 * 32768 + 17);
    const source = tempDirBridge.getTempFilePath(`term-upload-${crypto.randomUUID()}.bin`);
    await fs.writeFile(source, payload);
    t.after(() => fs.rm(source, { force: true }));
    const files = new Map();
    const handles = new Map();
    const target = `/target-${crypto.randomUUID()}.bin`;
    const sftp = new EventEmitter();
    const missing = () => Object.assign(new Error("ENOENT"), { code: 2 });
    const stats = (p) => {
      const data = files.get(String(p));
      if (!data) throw missing();
      return { size: data.length, mode: 0o100644, mtime: 1, isDirectory: () => false, isSymbolicLink: () => false };
    };
    Object.assign(sftp, {
      _client: { _remoteVer: "TERM-SSHD" },
      readdir(_p, cb) { cb(null, []); }, mkdir(_p, cb) { cb(null); },
      stat(p, cb) { try { cb(null, stats(p)); } catch (err) { cb(err); } },
      lstat(p, cb) { try { cb(null, stats(p)); } catch (err) { cb(err); } },
      unlink(p, cb) { files.delete(String(p)); cb(null); },
      chmod(_p, _mode, cb) { cb(null); },
      open(p, flags, cb) {
        const name = String(p);
        if (flags === "w") files.set(name, Buffer.alloc(payload.length));
        const handle = Buffer.from(crypto.randomUUID());
        handles.set(handle, { name, cursor: 0 }); cb(null, handle);
      },
      write(handle, buffer, offset, length, _position, cb) {
        const h = handles.get(handle);
        const data = files.get(h.name);
        buffer.copy(data, h.cursor, offset, offset + length);
        if (corrupt && h.cursor <= 40000 && h.cursor + length > 40000) data[40000] ^= 0xff;
        h.cursor += length; setImmediate(() => cb(null));
      },
      read(handle, buffer, offset, length, _position, cb) {
        const h = handles.get(handle); const data = files.get(h.name);
        const count = Math.min(length, data.length - h.cursor);
        data.copy(buffer, offset, h.cursor, h.cursor + count); h.cursor += count;
        setImmediate(() => cb(null, count));
      },
      close(handle, cb) { handles.delete(handle); cb(null); },
      end() {},
    });
    const client = {
      sftp, __netcattySingleChannelSsh: true,
      stat: async (p) => stats(p),
      rename: async (from, to) => { files.set(String(to), files.get(String(from))); files.delete(String(from)); },
      delete: async (p) => { files.delete(String(p)); },
      client: { _remoteVer: "TERM-SSHD", sftp() { throw new Error("No terminal subsystem reuse"); } },
    };
    transferBridge.init({ sftpClients: new Map([["sequential", client]]) });
    const result = await transferBridge.startTransfer({ sender: { send() {} } }, {
      transferId: crypto.randomUUID(), sourcePath: source, targetPath: target,
      sourceType: "local", targetType: "sftp", targetSftpId: "sequential",
      totalBytes: payload.length, resumable: true,
    });
    if (corrupt) {
      assert.match(result.error || "", /content verification failed/i);
      assert.equal(files.has(target), false, "corrupt stage must never be promoted");
    } else {
      assert.equal(result.error, undefined);
      assert.deepEqual(files.get(target), payload);
    }
  });
}
