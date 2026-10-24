'use strict';

// Native Electron integration, not a hypervisor fixture: the disposable server
// implements the same local Windows pipe byte-stream contract as a VM console.
if (!process.versions.electron) {
  require('node:test')('serial named pipe Electron integration', {
    skip: 'run electron scripts/serial-named-pipe.live.test.cjs',
  }, () => {});
} else {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const net = require('node:net');
  const { spawn, execFileSync } = require('node:child_process');
  const { randomUUID } = require('node:crypto');
  const electron = require('electron');
  const { app, BrowserWindow, ipcMain, protocol } = electron;
  protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
  const sessions = new Map();
  const peers = new Set();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'netcatty-pipe-electron-'));
  app.setPath('userData', profile);
  app.on('window-all-closed', () => {});
  let win;
  let server;
  let bridge;
  let busyServer;
  let busyOwner;
  let finishing = false;
  const watchdog = setTimeout(() => finish(1, new Error('serial pipe Electron test timed out')), 45000);
  function finish(code, error) {
    if (finishing) return;
    finishing = true;
    clearTimeout(watchdog);
    if (error) console.error(error);
    bridge?.cleanupAllSessions();
    for (const peer of peers) peer.destroy();
    server?.close();
    busyOwner?.destroy();
    busyServer?.kill();
    if (win && !win.isDestroyed()) win.destroy();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Windows may hold cache files until exit. */ }
    app.exit(code);
  }
  const js = (source) => win.webContents.executeJavaScript(source);
  const subscribe = (sessionId) => js(`window.pipeDataOff?.(); window.pipeExitOff?.(); window.pipeOutput = ''; window.pipeExits = []; window.pipeDataOff = window.netcatty.onSessionData(${JSON.stringify(sessionId)}, data => { window.pipeOutput += data; document.getElementById('output').textContent = window.pipeOutput; window.netcatty.ackSessionFlow(${JSON.stringify(sessionId)}, data.length); }); window.pipeExitOff = window.netcatty.onSessionExit(${JSON.stringify(sessionId)}, event => window.pipeExits.push(event)); void 0;`);
  async function waitFor(source, timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await js(source)) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out: ${source}`);
  }
  async function main() {
    bridge = require('../electron/bridges/terminalBridge.cjs');
    bridge.init({ sessions, electronModule: electron });
    bridge.registerHandlers(ipcMain);
    win = new BrowserWindow({ show: false, webPreferences: {
      preload: path.join(__dirname, '../electron/preload.cjs'),
      contextIsolation: true, nodeIntegration: false,
      // Match the production main-window preload configuration.
      sandbox: false,
    } });
    protocol.handle('app', () => new Response('<title>Serial pipe integration</title><pre id="output"></pre>', { headers: { 'content-type': 'text/html' } }));
    await win.loadURL('app://netcatty/serial-pipe-test');
    assert.equal(await js('typeof window.netcatty.startSerialSession'), 'function');
    const endpoint = String.raw`\\.\pipe\netcatty VM console ${randomUUID()}`;
    const busyName = `netcatty-busy-${randomUUID()}`;
    const busyPath = '\\\\.\\pipe\\' + busyName;
    assert.ok(busyPath.endsWith(busyName) && !busyPath.includes('${'));
    if (process.platform !== 'win32') {
      // Exercise callback registration too; functions must never be returned
      // from executeJavaScript across Electron's structured-clone boundary.
      await subscribe('unsupported');
      await assert.rejects(js(`window.netcatty.startSerialSession(${JSON.stringify({ sessionId: 'unsupported', path: endpoint })})`), /only supported on Windows/);
      assert.equal(sessions.size, 0);
      console.log('SERIAL_PIPE_ELECTRON_PASS: native preload/IPC rejects Windows pipes on non-Windows');
      return;
    }
    const received = [];
    let slowReader = false;
    server = net.createServer(peer => {
      peers.add(peer);
      if (slowReader) peer.pause();
      peer.on('error', () => {});
      peer.on('close', () => peers.delete(peer));
      peer.on('data', data => { received.push(data); peer.write(data); });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(endpoint, resolve);
    });
    const sessionId = 'native-pipe-session';
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal(await js(`window.netcatty.startSerialSession(${JSON.stringify({ sessionId, path: endpoint, charset: 'utf-8' })})`), sessionId);
      assert.equal(sessions.get(sessionId).type, 'serial');
      await subscribe(sessionId);
      const payload = `round ${attempt}: café 中文\r\n`;
      await js(`window.netcatty.writeToSession(${JSON.stringify(sessionId)}, ${JSON.stringify(payload)})`);
      await waitFor(`window.pipeOutput === ${JSON.stringify(payload)}`);
      assert.ok(Buffer.concat(received).toString('utf8').includes(payload), 'renderer input reaches the real Windows pipe server');
      assert.equal(await js("document.getElementById('output').textContent"), payload);
      if (attempt === 0) {
        await js(`window.netcatty.closeSession(${JSON.stringify(sessionId)})`);
        assert.equal(sessions.has(sessionId), false);
      } else {
        for (const peer of peers) peer.destroy();
        await waitFor('window.pipeExits.length === 1');
        assert.equal(sessions.has(sessionId), false, 'broken pipe removes backend session');
        await js(`window.netcatty.closeSession(${JSON.stringify(sessionId)})`);
      }
    }
    // Bound stress to 1 MiB: pause the server reader, then verify exact bytes
    // through both directions without introducing a different flow-control path.
    slowReader = true;
    received.length = 0;
    await js(`window.netcatty.startSerialSession(${JSON.stringify({ sessionId: 'slow-reader', path: endpoint })})`);
    await subscribe('slow-reader');
    const largePayload = '0123456789abcdef'.repeat(65536);
    await js(`window.netcatty.writeToSession('slow-reader', ${JSON.stringify(largePayload)})`);
    const queueDeadline = Date.now() + 5000;
    while (sessions.get('slow-reader').serialPort.writableLength === 0 && Date.now() < queueDeadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const queuedBytes = sessions.get('slow-reader').serialPort.writableLength;
    assert.ok(queuedBytes > 0, 'paused reader must leave a pending transport write');
    assert.ok(queuedBytes <= Buffer.byteLength(largePayload), 'bounded write queue');
    for (const peer of peers) peer.resume();
    await waitFor(`window.pipeOutput.length === ${largePayload.length}`, 15000);
    assert.equal(Buffer.concat(received).toString('utf8'), largePayload);
    assert.equal(await js('window.pipeOutput'), largePayload);
    assert.equal(sessions.get('slow-reader').serialPort.writableLength, 0);
    await js("window.netcatty.closeSession('slow-reader')");
    console.log(`SERIAL_PIPE_SLOW_READER_PASS: 1048576 exact bytes, observed queued bytes=${queuedBytes}, drained=0`);

    // Node net.Server permits multiple simultaneous clients. Use a tiny .NET
    // server to reproduce a real single-instance pipe's ERROR_PIPE_BUSY path.
    const fixtureExe = path.join(profile, 'single-instance-pipe.exe');
    const compiler = path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    execFileSync(compiler, ['/nologo', '/target:exe', `/out:${fixtureExe}`,
      path.join(__dirname, 'fixtures/serial/single-instance-pipe.cs')]);
    busyServer = spawn(fixtureExe, [busyName], { stdio: ['ignore', 'pipe', 'pipe'] });
    let fixtureErrors = '';
    busyServer.stderr.on('data', chunk => { fixtureErrors += chunk; });
    busyServer.on('exit', code => { if (!finishing) finish(1, new Error(`Pipe fixture exited ${code}: ${fixtureErrors}`)); });
    await new Promise((resolve, reject) => {
      let output = '';
      busyServer.once('error', reject);
      busyServer.once('exit', code => reject(new Error(`Pipe fixture exited ${code}`)));
      busyServer.stdout.on('data', chunk => { output += chunk; if (output.includes('READY')) resolve(); });
    });
    busyOwner = net.connect(busyPath);
    await new Promise((resolve, reject) => { busyOwner.once('connect', resolve); busyOwner.once('error', reject); });
    const { SerialNamedPipe } = require('../electron/bridges/serialNamedPipe.cjs');
    const originalOpen = SerialNamedPipe.prototype.open;
    let pendingTransport;
    let pendingTransportClosed;
    // Observe the real transport, without replacing its connect/close behavior.
    SerialNamedPipe.prototype.open = function (callback) {
      if (this.path === busyPath) {
        SerialNamedPipe.prototype.open = originalOpen;
        pendingTransport = this;
        pendingTransportClosed = new Promise(resolve => this.once('close', resolve));
      }
      return originalOpen.call(this, callback);
    };
    await js(`window.busyResult = 'pending'; window.busyPromise = window.netcatty.startSerialSession(${JSON.stringify({ sessionId: 'busy', path: busyPath })}).then(() => { window.busyResult = 'connected'; }, error => { window.busyResult = error.message; }); void 0;`);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await js('window.busyResult'), 'pending', 'single-instance pipe must be busy');
    await js("window.netcatty.closeSession('busy')");
    await waitFor("window.busyResult !== 'pending'");
    assert.match(await js('window.busyResult'), /superseded|closed before opening/i);
    assert.equal(sessions.has('busy'), false);
    busyOwner.destroy();
    assert.ok(pendingTransportClosed, 'observe the pending real transport');
    await pendingTransportClosed;
    assert.equal(pendingTransport.destroyed, true);
    // Reconnect after releasing the occupied pipe. This also proves a cancelled
    // late connect cannot keep the one server instance occupied indefinitely.
    assert.equal(await js(`window.netcatty.startSerialSession(${JSON.stringify({ sessionId: 'busy-reconnect', path: busyPath })})`), 'busy-reconnect');
    await subscribe('busy-reconnect');
    await js("window.netcatty.writeToSession('busy-reconnect', 'after cancellation')");
    await waitFor("window.pipeOutput === 'after cancellation'");
    await js("window.netcatty.closeSession('busy-reconnect')");
    assert.equal(sessions.has('busy'), false, 'cancelled late connect must not create a session');
    console.log('SERIAL_PIPE_BUSY_PASS: pending cancel, late-connect cleanup, manual reconnect');

    await new Promise(resolve => server.close(resolve));
    server = null;
    await assert.rejects(js(`window.netcatty.startSerialSession(${JSON.stringify({ sessionId: 'missing', path: endpoint })})`), /Failed to open serial port/);
    // A deliberately nonexistent hardware port still takes the SerialPort path,
    // not the pipe adapter. This does not claim testing physical COM hardware.
    await assert.rejects(js(`window.netcatty.startSerialSession({sessionId:'missing-com',path:'COM999999',baudRate:9600})`), /Failed to open serial port/);
    assert.equal(sessions.size, 0);
    console.log('SERIAL_PIPE_ELECTRON_PASS: real Windows pipe, renderer/preload/IPC, UTF-8 I/O, reconnect, disconnect, missing pipe and COM error');
  }
  app.whenReady().then(main).then(() => finish(0), error => finish(1, error));
}
