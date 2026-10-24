"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const transferBridge = require("./transferBridge.cjs");
const sftpBridge = require("./sftpBridge.cjs");
const tempDirBridge = require("./tempDirBridge.cjs");

function createClient(files, targetPath, cleanupCode) {
  const missing = () => Object.assign(new Error("No such file"), { code: 2 });
  const attrs = (remotePath) => {
    const bytes = files.get(String(remotePath));
    if (!bytes) throw missing();
    return { size: bytes.length, mode: 0o100644, isDirectory: () => false, isSymbolicLink: () => false };
  };
  const sftp = new EventEmitter();
  Object.assign(sftp, {
    lstat(remotePath, callback) { try { callback(null, attrs(remotePath)); } catch (error) { callback(error); } },
    stat(remotePath, callback) { try { callback(null, attrs(remotePath)); } catch (error) { callback(error); } },
    mkdir(_remotePath, callback) { callback(null); },
    unlink(remotePath, callback) { files.delete(String(remotePath)); callback(null); },
    readdir(_remotePath, callback) { callback(null, []); },
    open(remotePath, flags, callback) {
      if (String(flags).includes("w")) files.set(String(remotePath), Buffer.alloc(0));
      callback(null, Buffer.from(String(remotePath)));
    },
    write(handle, buffer, offset, length, position, callback) {
      const key = handle.toString();
      const bytes = Buffer.alloc(Math.max(files.get(key)?.length || 0, position + length));
      files.get(key)?.copy(bytes);
      buffer.copy(bytes, position, offset, offset + length);
      files.set(key, bytes);
      setImmediate(() => callback(null));
    },
    read(handle, buffer, offset, length, position, callback) {
      const bytes = files.get(handle.toString()) || Buffer.alloc(0);
      const part = bytes.subarray(position, position + length);
      part.copy(buffer, offset);
      setImmediate(() => callback(null, part.length));
    },
    close(_handle, callback) { callback(null); },
    createReadStream(remotePath, options = {}) {
      const bytes = files.get(String(remotePath)) || Buffer.alloc(0);
      return Readable.from([bytes.subarray(options.start || 0, options.end === undefined ? undefined : options.end + 1)]);
    },
    end() { assert.fail("cleanup warning must not close the shared SFTP channel"); },
  });
  return {
    __netcattySudoMode: true,
    sftp,
    async stat(remotePath) { const value = attrs(remotePath); return { size: value.size, isDirectory: false }; },
    async chmod() {},
    async delete(remotePath) {
      if (String(remotePath).includes(".netcatty-backup-")) {
        throw Object.assign(new Error("fixture cleanup failure"), { code: cleanupCode });
      }
      files.delete(String(remotePath));
    },
    async rename(fromPath, toPath) {
      const from = String(fromPath);
      const to = String(toPath);
      if (to === targetPath && files.has(to)) throw new Error("atomic replace unavailable");
      if (!files.has(from)) throw missing();
      files.set(to, files.get(from));
      files.delete(from);
    },
    async end() { assert.fail("cleanup warning must not disconnect the SFTP session"); },
  };
}

for (const mode of ["upload", "remote-to-remote", "direct-api", "real-failure"]) {
  test(`${mode} propagates the committed backup cleanup outcome`, async (t) => {
    const localPath = tempDirBridge.getTempFilePath(`upload-warning-${mode}.bin`);
    const payload = Buffer.from("new complete upload");
    fs.writeFileSync(localPath, payload);
    t.after(() => fs.rmSync(localPath, { force: true }));
    const targetPath = "/remote/file.bin";
    const targetFiles = new Map([[targetPath, Buffer.from("original bytes")]]);
    const target = createClient(targetFiles, targetPath, mode === "real-failure" ? 4 : 3);
    const source = createClient(new Map([["/source/file.bin", payload]]), null, 3);
    const clients = new Map([["target", target], ["source", source]]);
    transferBridge.init({ sftpClients: clients });
    sftpBridge.init({ sftpClients: clients });
    const sent = [];
    const sender = { send(channel, event) { sent.push({ channel, event }); } };
    const transferId = `warning-${mode}`;
    const result = mode === "direct-api"
      ? await sftpBridge.uploadLocalToSftp(null, {
        sftpId: "target", localPath, remotePath: targetPath, transferId,
        onTransferEvent: (channel, event) => sender.send(channel, event),
      })
      : await transferBridge.startTransfer({ sender }, {
        transferId,
        sourceType: mode === "remote-to-remote" ? "sftp" : "local",
        sourcePath: mode === "remote-to-remote" ? "/source/file.bin" : localPath,
        sourceSftpId: mode === "remote-to-remote" ? "source" : undefined,
        targetPath, targetType: "sftp", targetSftpId: "target", totalBytes: payload.length,
      });
    assert.deepEqual(targetFiles.get(targetPath), payload);
    const backupPath = [...targetFiles.keys()].find((key) => key.includes(".netcatty-backup-"));
    assert.ok(backupPath);
    assert.deepEqual(targetFiles.get(backupPath), Buffer.from("original bytes"));
    if (mode === "real-failure") {
      assert.ok(result.error);
      assert.equal(result.warning, undefined);
      assert.equal(sent.some(({ channel }) => channel === "netcatty:transfer:complete"), false);
      assert.equal(sent.some(({ channel }) => channel === "netcatty:transfer:error"), true);
    } else {
      assert.equal(result.error, undefined);
      assert.ok(result.warning?.includes(backupPath), "return value includes the actionable backup path");
      const completion = sent.find(({ channel }) => channel === "netcatty:transfer:complete")?.event;
      assert.equal(completion?.warning, result.warning);
      assert.equal(completion?.totalBytes, payload.length);
      assert.equal(sent.some(({ channel }) => channel === "netcatty:transfer:error" || channel === "netcatty:transfer:cancelled"), false);
    }
    assert.equal(clients.get("target"), target);
  });
}
