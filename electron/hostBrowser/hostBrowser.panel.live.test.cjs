"use strict";

// Run with: electron electron/hostBrowser/hostBrowser.panel.live.test.cjs
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const os = require("node:os");
const { Server } = require("ssh2");
const electron = require("electron");
const { app, BrowserWindow, WebContentsView } = electron;
const portForwardingBridge = require("../bridges/portForwardingBridge.cjs");
const { createHostBrowserManager } = require("./hostBrowserManager.cjs");

async function waitFor(read, expected) {
  for (let index = 0; index < 100; index += 1) {
    if (await read() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(await read(), expected);
}

async function fixture(label) {
  const sockets = new Set();
  const allowed = new Set();
  let connections = 0;
  const site = http.createServer((request, response) => {
    assert.ok(allowed.has(request.socket.remotePort), "page must arrive through its SSH host");
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<title>${label}</title><h1>${label}</h1>`);
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("authentication", (context) => context.method === "password" ? context.accept() : context.reject());
    client.on("ready", () => client.on("tcpip", (accept, reject, info) => {
      if (info.destPort !== site.address().port) return reject();
      connections += 1;
      const channel = accept();
      const target = net.connect(site.address().port, "127.0.0.1");
      target.once("connect", () => { allowed.add(target.localPort); channel.pipe(target).pipe(channel); });
      target.on("close", () => allowed.delete(target.localPort));
      target.on("error", () => channel.destroy());
      channel.on("error", () => target.destroy());
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    options: { hostId: label, type: "dynamic", hostname: "127.0.0.1", port: server.address().port,
      username: "test", authMethod: "password", password: "fixture", verifyHostKeys: false, knownHosts: [] },
    url: `http://localhost:${site.address().port}/`,
    connections: () => connections,
    close() { for (const socket of sockets) socket.end(); server.close(); site.closeAllConnections(); site.close(); },
  };
}

async function main() {
  app.setPath("userData", path.join(os.tmpdir(), `netcatty-browser-panel-${process.pid}`));
  const a = await fixture("Host A");
  const b = await fixture("Host B");
  const owner = new BrowserWindow({ width: 1100, height: 760, show: true });
  await owner.loadURL("data:text/html,<h1>Terminal workspace</h1>");
  const ownerEvents = ["blur", "resize", "maximize", "unmaximize", "closed"];
  const beforeListeners = ownerEvents.map((name) => owner.listenerCount(name));
  const manager = createHostBrowserManager({ electron, app, portForwardingBridge });
  const event = { sender: owner.webContents };
  const bounds = { x: 680, y: 50, width: 400, height: 650 };
  const layout = (browserId, visible, nextBounds = bounds) => manager.updatePanelLayout(event, { browserId, visible, bounds: nextBounds });
  const open = async (id, host) => {
    layout(id, true);
    await manager.open(event, { browserId: id, embedded: true, hostId: host.options.hostId,
      label: host.options.hostId, theme: "light", connectionOptions: host.options });
    return owner.contentView.children.find((view) => view.children.some((child) => child instanceof WebContentsView
      && child.webContents.getURL().endsWith("browser.html")));
  };
  manager.openPanelUrl(event, { browserId: "workspace:session-a", url: a.url });
  const rootA = await open("workspace:session-a", a);
  const chromeA = rootA.children[0].webContents;
  const snapshotA = () => chromeA.executeJavaScript("window.hostBrowser.snapshot()");
  assert.equal((await snapshotA()).embedded, true);
  assert.equal(await chromeA.executeJavaScript("document.querySelector('#route') === null"), true);
  assert.equal(await chromeA.executeJavaScript("document.documentElement.scrollWidth <= innerWidth"), true);
  await waitFor(async () => (await snapshotA()).tabs[0].title, "Host A");
  const chromeBottom = await chromeA.executeJavaScript("document.querySelector('.chrome').getBoundingClientRect().bottom");
  const pageA = rootA.children.find((child) => child instanceof WebContentsView && child.webContents.getURL() === a.url);
  assert.equal(pageA.getBounds().y, chromeBottom, "page must meet the compact toolbar without a gap or overlap");
  await chromeA.executeJavaScript("document.querySelector('.tab').dispatchEvent(new MouseEvent('contextmenu', {bubbles:true,clientX:30,clientY:20}))");
  await waitFor(() => rootA.children.includes(pageA), false);
  await chromeA.executeJavaScript("document.querySelector('#tab-icon-change').click()");
  assert.equal(rootA.children.includes(pageA), false, "web content must not cover the icon editor");
  assert.equal(await chromeA.executeJavaScript("document.querySelector('#tab-icon-editor').hidden"), false);
  await chromeA.executeJavaScript("document.querySelector('#tab-icon-cancel').click()");
  await waitFor(() => rootA.children.includes(pageA), true);
  layout("workspace:session-a", false);
  assert.equal(owner.contentView.children.includes(rootA), false);
  // A locked desktop cannot grant focus; keep the focus check enabled by default.
  if (!process.env.NETCATTY_BROWSER_SMOKE_SKIP_FOCUS) await waitFor(() => owner.webContents.isFocused(), true);
  const rootB = await open("workspace:session-b", b);
  const chromeB = rootB.children[0].webContents;
  await chromeB.executeJavaScript(`window.hostBrowser.command({type:'navigate',url:${JSON.stringify(b.url)}})`);
  await waitFor(async () => (await chromeB.executeJavaScript("window.hostBrowser.snapshot()")).tabs[0].title, "Host B");
  assert.equal(BrowserWindow.getAllWindows().length, 1, "panels must not create popup windows");
  layout("workspace:session-b", false);
  layout("workspace:session-a", true, { x: 20, y: 80, width: 350, height: 500 });
  assert.deepEqual(rootA.getBounds(), { x: 20, y: 80, width: 350, height: 500 });
  assert.equal((await snapshotA()).tabs[0].title, "Host A", "focus switch preserves the earlier page");
  assert.equal(owner.contentView.children.includes(rootB), false, "old context must leave the screen");
  for (let index = 0; index < 6; index += 1) {
    await chromeA.executeJavaScript("window.hostBrowser.command({type:'new-tab'})");
  }
  assert.equal(await chromeA.executeJavaScript(`(() => {
    const button = document.querySelector('#new-tab').getBoundingClientRect();
    return document.documentElement.scrollWidth <= innerWidth && button.left >= 0 && button.right <= innerWidth;
  })()`), true, "tabs must scroll within a narrow pane and leave the add button reachable");
  await chromeA.executeJavaScript("document.querySelector('#add-app').click()");
  assert.equal(await chromeA.executeJavaScript("document.querySelector('#bookmark-panel').getBoundingClientRect().width <= innerWidth"), true);
  await chromeA.executeJavaScript("document.querySelector('#bookmark-close').click()");
  await chromeA.executeJavaScript("window.hostBrowser.command({type:'set-download-panel',open:true})");
  const downloads = rootA.children.find((child) => child instanceof WebContentsView && child.webContents.getURL().endsWith("downloads.html"));
  assert.ok(downloads);
  assert.ok(downloads.getBounds().width <= rootA.getBounds().width);
  assert.equal(downloads.getBounds().y, chromeBottom, "downloads must start below the compact toolbar");
  const otherOwner = new BrowserWindow({ show: false });
  assert.throws(() => manager.updatePanelLayout({ sender: otherOwner.webContents }, { browserId: "workspace:session-a", visible: false }), /another terminal window/);
  assert.throws(() => manager.openPanelUrl({ sender: otherOwner.webContents }, { browserId: "workspace:session-a", url: a.url }), /another terminal window/);
  assert.throws(() => manager.openPanelUrl(event, { browserId: "workspace:session-a", url: "file:///etc/passwd" }), /HTTP and HTTPS/);
  otherOwner.destroy();
  assert.ok(a.connections() > 0 && b.connections() > 0);
  manager.closePanel(event, "workspace:session-a");
  await waitFor(() => chromeA.isDestroyed(), true);
  assert.equal(owner.isDestroyed(), false, "closing browser must keep the terminal window alive");
  const localSite = http.createServer((request, response) => {
    if (request.url === '/slow.bin') {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': 1048576 });
      response.write(Buffer.alloc(16384));
      return;
    }
    response.end('<title>Local browser</title><h1>Local browser</h1>');
  });
  await new Promise((resolve) => localSite.listen(0, "127.0.0.1", resolve));
  manager.openPanelUrl(event, { browserId: "local:session", url: `http://127.0.0.1:${localSite.address().port}/` });
  layout("local:session", true);
  await manager.open(event, { browserId: "local:session", embedded: true, local: true,
    hostId: "local", label: "Local terminal", theme: "light" });
  const localRoot = owner.contentView.children.find((view) => view.children.some((child) => child instanceof WebContentsView
    && child.webContents.getURL().endsWith("browser.html")));
  const localChrome = localRoot.children[0].webContents;
  await waitFor(async () => (await localChrome.executeJavaScript("window.hostBrowser.snapshot()")).tabs[0].title, "Local browser");
  assert.equal((await localChrome.executeJavaScript("window.hostBrowser.snapshot()")).tabs.length, 1, "first terminal link reuses the blank tab");
  const localPage = localRoot.children.find((child) => child instanceof WebContentsView && child !== localRoot.children[0]);
  layout('local:session', false);
  layout('local:peer', true);
  await manager.open(event, { browserId: 'local:peer', embedded: true, local: true,
    hostId: 'local', label: 'Same host peer', theme: 'light' });
  const peerRoot = owner.contentView.children.find((view) => view.children.some((child) => child instanceof WebContentsView
    && child.webContents.getURL().endsWith('browser.html')));
  await peerRoot.children[0].webContents.executeJavaScript("window.hostBrowser.command({type:'set-download-panel',open:true})");
  const peerDownloads = peerRoot.children.find((child) => child instanceof WebContentsView && child.webContents.getURL().endsWith('downloads.html')).webContents;
  let activeDownload;
  const startDownload = async () => {
    activeDownload = undefined;
    localPage.webContents.session.once('will-download', (_downloadEvent, item) => {
      activeDownload = item;
      item.setSavePath(path.join(app.getPath('userData'), 'closing-download.bin'));
    });
    localPage.webContents.downloadURL(`http://127.0.0.1:${localSite.address().port}/slow.bin`);
    await waitFor(() => Boolean(activeDownload), true);
  };
  await startDownload();
  let cancelled = false;
  activeDownload.once('done', (_downloadEvent, status) => { cancelled = status === 'cancelled'; });
  await waitFor(() => peerDownloads.executeJavaScript("Boolean(document.querySelector('button[title=\"Cancel download\"]'))"), true);
  await peerDownloads.executeJavaScript("window.hostBrowserDownloads.list().then(items => window.hostBrowserDownloads.command('cancel', items[0].id))");
  await waitFor(() => cancelled, true);
  await waitFor(() => peerDownloads.executeJavaScript("Boolean(document.querySelector('button[title=\"Cancel download\"]'))"), false);
  manager.closePanel(event, 'local:peer');
  await startDownload();
  cancelled = false;
  activeDownload.once('done', (_downloadEvent, status) => { cancelled = status === 'cancelled'; });
  manager.closePanel(event, 'local:session');
  await waitFor(() => cancelled, true);
  await waitFor(() => localChrome.isDestroyed(), true);
  assert.equal(owner.isDestroyed(), false, 'closing during a download must keep the terminal alive');
  manager.closeAll();
  localSite.closeAllConnections();
  localSite.close();
  assert.equal(owner.isDestroyed(), false);
  assert.deepEqual(ownerEvents.map((name) => owner.listenerCount(name)), beforeListeners);
  owner.destroy();
  a.close(); b.close();
  console.log(JSON.stringify({ ok: true, embedded: true, hostSwitching: true, pageRetention: true, popups: 0 }));
  app.quit();
}

app.whenReady().then(main).catch((error) => { console.error(error); app.exit(1); });
