/* global document, window */
'use strict';
const element = (id) => document.getElementById(id);
const invoke = (operation, params = {}) => window.netcattyView.executeCommand(`com.netcatty.assistant.${operation}`, params);
let chat;
let turn;
let generation = 0;
const references = new Map();
function busy(value) {
  element('send').disabled = value || !chat;
  element('stop').disabled = !value;
  element('context').disabled = value;
  element('prompt').disabled = value;
}
async function initialize() {
  try {
    chat = await invoke('open');
    element('model').textContent = chat.model;
    const summaries = await invoke('contexts');
    for (const reference of summaries) {
      if (reference.scope !== 'note') continue;
      references.set(reference.handle, { handle: reference.handle, version: reference.version });
      const option = document.createElement('option');
      option.value = reference.handle; option.textContent = reference.title;
      element('context').append(option);
    }
    element('status').textContent = 'Ready';
    busy(false);
  } catch {
    element('status').textContent = 'Choose a model and grant access in Netcatty.';
  }
}
element('compose').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!chat || element('send').disabled) return;
  const run = ++generation;
  busy(true); element('status').textContent = 'Streaming...';
  element('response').textContent = ''; element('usage').textContent = '';
  try {
    const reference = references.get(element('context').value);
    const started = await invoke('send', { chatHandle: chat.chatHandle, prompt: element('prompt').value,
      contexts: reference ? [reference] : [] });
    if (run !== generation) { await invoke('stop', { turnHandle: started.turnHandle }); return; }
    turn = started.turnHandle;
    for (;;) {
      const chunk = await invoke('read', { turnHandle: turn });
      if (run !== generation) return;
      if (chunk.kind === 'end') break;
      if (chunk.kind === 'text') element('response').textContent += chunk.text;
      if (chunk.kind === 'usage') element('usage').textContent = `${chunk.inputTokens ?? '?'} input tokens · ${chunk.outputTokens ?? '?'} output tokens`;
    }
    element('status').textContent = 'Complete';
  } catch {
    if (run === generation) element('status').textContent = 'Request ended. Check access or try again.';
  } finally {
    if (run === generation) { turn = undefined; busy(false); }
  }
});
element('stop').addEventListener('click', async () => {
  ++generation;
  const stoppedTurn = turn; turn = undefined;
  element('status').textContent = 'Stopping...';
  try {
    if (stoppedTurn) await invoke('stop', { turnHandle: stoppedTurn });
    else if (chat) {
      await invoke('close', { chatHandle: chat.chatHandle });
      chat = await invoke('open');
    }
  }
  finally { element('status').textContent = 'Stopped'; busy(false); }
});
// QA supplies this text through the regular view message surface.
window.netcattyView.onDidReceiveMessage((message) => {
  if (message?.qaFixture === true) element('qa').textContent = 'Isolated QA · deterministic local provider · no model inference or paid API';
});
window.addEventListener('pagehide', () => { if (turn) invoke('stop', { turnHandle: turn }).catch(() => {}); });
void initialize();
