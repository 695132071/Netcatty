// A separate renderer thread lets the real main-process timeout run while
// window.confirm is synchronously blocked, just like Electron's native dialog.
require("tsx/cjs");
const { parentPort, workerData } = require("node:worker_threads");
const { EventEmitter } = require("node:events");
const React = require("react");
const { act, create } = require("react-test-renderer");
const { useAppStartupEffects } = require("../useAppStartupEffects.ts");
const { sftpTransferCenterStore } = require("../../state/sftpTransferCenterStore.ts");
const { netcattyBridge } = require("../../../infrastructure/services/netcattyBridge.ts");
const { createPreloadApi } = require("../../../electron/preload/api.cjs");
const signal = new Int32Array(workerData.signal);
let resumes = 0;
global.IS_REACT_ACT_ENVIRONMENT = true;
global.window = {
  confirm() {
    parentPort.postMessage({ type: "prompt" });
    Atomics.wait(signal, 0, 0, 10000);
    return workerData.accept;
  },
};
sftpTransferCenterStore.getSnapshot = () => ({ tasks: [{ id: "held-prompt", status: "transferring" }] });
sftpTransferCenterStore.pause = async () => {};
sftpTransferCenterStore.resume = async () => { resumes++; };
const ipcRenderer = Object.assign(new EventEmitter(), {
  send(channel, payload) { parentPort.postMessage({ type: "reply", channel, payload }); },
});
const preload = createPreloadApi({ ipcRenderer, webUtils: {} });
netcattyBridge.get = () => ({
  onCheckDirtyEditors(callback) {
    return preload.onCheckDirtyEditors((request) => {
      void callback(request).then(() => parentPort.postMessage({ type: "done", resumes }));
    });
  },
  reportDirtyEditorsResult: preload.reportDirtyEditorsResult,
});
function Probe() {
  useAppStartupEffects({ enabled: false, updateState: {}, sessions: [], hosts: [], keys: [], identities: [], knownHosts: [], proxyProfiles: [], groupConfigs: [], workspaces: [], portForwardingRules: [], t: (key) => key });
  return null;
}
parentPort.on("message", ({ channel, payload }) => ipcRenderer.emit(channel, {}, payload));
void act(async () => { create(React.createElement(Probe)); })
  .then(() => parentPort.postMessage({ type: "ready" }));
