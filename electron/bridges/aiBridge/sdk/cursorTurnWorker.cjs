"use strict";

const { runCursorTurnInProcess } = require("./cursorDriver.cjs");

const controller = new AbortController();
const emitter = {};
for (const method of [
  "text", "reasoning", "reasoningEnd", "toolCall", "toolResult",
  "sessionId", "emitDone", "emitError",
]) {
  emitter[method] = (...args) => process.parentPort.postMessage({ type: "event", method, args });
}

let started = false;
let pendingPrompt = null;
function getPrompt() {
  return new Promise((resolve, reject) => {
    if (controller.signal.aborted) {
      reject(new Error("Cursor turn was interrupted"));
      return;
    }
    pendingPrompt = { resolve, reject };
    process.parentPort.postMessage({ type: "prompt-request" });
  });
}
process.parentPort.on("message", ({ data }) => {
  if (data?.type === "abort") {
    controller.abort();
    pendingPrompt?.reject(new Error("Cursor turn was interrupted"));
    pendingPrompt = null;
  }
  if (data?.type === "prompt") {
    pendingPrompt?.resolve({ prompt: data.prompt, attachments: data.attachments });
    pendingPrompt = null;
  }
  if (data?.type === "start" && !started) {
    started = true;
    void runCursorTurnInProcess({
      ...data.params, emitter, signal: controller.signal,
      getPrompt: data.params.deferPrompt ? getPrompt : undefined,
    }).then(
      (result) => process.parentPort.postMessage({ type: "result", result }),
      (error) => process.parentPort.postMessage({ type: "error", message: error?.message || String(error) }),
    );
  }
});
