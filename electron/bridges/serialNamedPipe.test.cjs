const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { SerialNamedPipe, isWindowsNamedPipePath, createSerialTransport } = require('./serialNamedPipe.cjs');

const endpoint = () => process.platform === 'win32'
  ? `\\\\.\\pipe\\netcatty-test-${randomUUID()}`
  : path.join(os.tmpdir(), `nc-${randomUUID()}.sock`);

async function echoServer(t) {
  const address = endpoint();
  const peers = new Set();
  const server = net.createServer((socket) => {
    peers.add(socket);
    socket.on('close', () => peers.delete(socket));
    socket.on('error', () => {});
    socket.on('data', (data) => socket.write(data));
  });
  server.listen(address);
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of peers) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { address, peers, server };
}

function open(port) {
  return new Promise((resolve, reject) => port.open((error) => error ? reject(error) : resolve()));
}

test('recognizes only local Windows named pipe paths', () => {
  for (const value of [String.raw`\\.\pipe\vm`, String.raw`\\?\pipe\VM console`, String.raw`\\.\PIPE\vm\console`]) {
    assert.equal(isWindowsNamedPipePath(value), true, value);
  }
  for (const value of [undefined, '', '\\\\.\\pipe\\', String.raw`\\server\pipe\vm`, 'COM1', '/dev/ttyS0', '\\\\.\\pipe\\vm\n']) {
    assert.equal(isWindowsNamedPipePath(value), false, String(value));
  }
});

test('real IPC stream carries binary input/output and can reconnect after close', { timeout: 10000 }, async (t) => {
  const { address } = await echoServer(t);
  for (let attempt = 0; attempt < 2; attempt++) {
    const port = new SerialNamedPipe(address);
    t.after(() => port.close());
    await open(port);
    const payload = Buffer.from([0, 1, 8, 13, 27, 127, 128, 255]);
    const received = once(port, 'data');
    await new Promise((resolve, reject) => port.write(payload, (error) => error ? reject(error) : resolve()));
    assert.deepEqual((await received)[0], payload);
    const closed = once(port, 'close');
    port.close();
    await closed;
  }
});

test('missing pipe fails opening once without an unhandled error', { timeout: 10000 }, async () => {
  const port = new SerialNamedPipe(endpoint());
  let callbacks = 0;
  const closed = new Promise((resolve) => port.once('close', resolve));
  await new Promise((resolve) => port.open((error) => {
    callbacks++;
    assert.ok(error);
    resolve();
  }));
  await closed;
  assert.equal(callbacks, 1);
});

test('closing during open cancels the pending connection once', { timeout: 10000 }, async (t) => {
  const { address } = await echoServer(t);
  const port = new SerialNamedPipe(address);
  let callbacks = 0;
  const closed = new Promise((resolve) => port.once('close', resolve));
  port.open((error) => {
    callbacks++;
    assert.match(error.message, /closed before opening/);
  });
  port.close();
  await closed;
  assert.equal(callbacks, 1);
  assert.equal(port.destroyed, true);
});

test('server disconnection closes the transport', { timeout: 10000 }, async (t) => {
  const { address, peers, server } = await echoServer(t);
  const port = new SerialNamedPipe(address);
  t.after(() => port.close());
  await Promise.all([once(server, 'connection'), open(port)]);
  const closed = once(port, 'close');
  for (const peer of peers) peer.end();
  await closed;
  assert.equal(port.destroyed, true);
});

test('transport selection preserves hardware settings and trims the path', () => {
  class HardwarePort { constructor(options) { this.options = options; } }
  const settings = { path: ' COM12 ', baudRate: 9600, parity: 'even', rtscts: true, autoOpen: false };
  const hardware = createSerialTransport(settings, HardwarePort, 'win32');
  assert.ok(hardware instanceof HardwarePort);
  assert.deepEqual(hardware.options, { ...settings, path: 'COM12' });
  const pipe = createSerialTransport({ ...settings, path: String.raw`\\.\pipe\vm` }, HardwarePort, 'win32');
  assert.ok(pipe instanceof SerialNamedPipe);
  pipe.close();
  assert.throws(() => createSerialTransport({ path: String.raw`\\.\pipe\vm` }, HardwarePort, 'linux'), /only supported on Windows/);
});
