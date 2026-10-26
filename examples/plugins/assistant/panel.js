/* global document, window */
'use strict';
const element = (id) => document.getElementById(id);
const invoke = (operation, params = {}) => window.netcattyView.executeCommand(`com.netcatty.assistant.${operation}`, params);
let chat;
let turn;
let generation = 0;
let closed = false;
const references = new Map();
function busy(value) {
  element('send').disabled = value || !chat;
  element('stop').disabled = !value;
  element('refresh').disabled = value;
  element('context').disabled = value;
  element('prompt').disabled = value;
}
async function replaceChat(run) {
  const previous = chat; chat = undefined;
  if (previous) await invoke('close', { chatHandle: previous.chatHandle }).catch(() => {});
  if (closed || run !== generation) return false;
  const opened = await invoke('open');
  if (closed || run !== generation) {
    await invoke('close', { chatHandle: opened.chatHandle }).catch(() => {});
    return false;
  }
  chat = opened;
  element('model').textContent = chat.model;
  return true;
}
async function initialize() {
  const run = ++generation;
  busy(true);
  try {
    if (!await replaceChat(run)) return;
    const summaries = await invoke('contexts');
    if (closed || run !== generation) return;
    for (const reference of summaries) {
      if (reference.scope !== 'note') continue;
      references.set(reference.handle, { handle: reference.handle, version: reference.version });
      const option = document.createElement('option');
      option.value = reference.handle; option.textContent = reference.title;
      element('context').append(option);
    }
    element('status').textContent = 'Ready';
  } catch {
    if (run !== generation) return;
    const failedChat = chat; chat = undefined;
    if (failedChat) await invoke('close', { chatHandle: failedChat.chatHandle }).catch(() => {});
    if (run === generation) element('status').textContent = 'Choose a model and grant access in Netcatty, then refresh the model.';
  } finally { if (run === generation) busy(false); }
}
element('refresh').addEventListener('click', async () => {
  if (closed || element('refresh').disabled) return;
  const run = ++generation;
  busy(true); element('status').textContent = 'Refreshing model...';
  try {
    if (await replaceChat(run)) element('status').textContent = 'Ready';
  } catch {
    if (run === generation) element('status').textContent = 'Choose a model and grant access in Netcatty, then refresh the model.';
  } finally { if (run === generation) busy(false); }
});
element('compose').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!chat || element('send').disabled) return;
  const run = ++generation;
  busy(true); element('status').textContent = 'Streaming...';
  element('response').textContent = ''; element('usage').textContent = '';
  try {
    // No inference has been requested yet, so an expired session can be
    // replaced before this explicit Send. Never retry a failed send/read.
    if (chat.expiresAt <= Date.now() && !await replaceChat(run)) return;
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
    if (run === generation) element('status').textContent = 'Request ended. Check access or refresh the model, then send again.';
  } finally {
    if (run === generation) { turn = undefined; busy(false); }
  }
});
element('stop').addEventListener('click', async () => {
  if (element('stop').disabled) return;
  const run = ++generation;
  const stoppedTurn = turn; turn = undefined;
  element('status').textContent = 'Stopping...'; element('stop').disabled = true;
  try {
    if (stoppedTurn) await invoke('stop', { turnHandle: stoppedTurn });
    else if (chat) {
      const stoppedChat = chat; chat = undefined;
      await invoke('close', { chatHandle: stoppedChat.chatHandle });
    }
  } catch { /* Closing a revoked session may already have stopped the turn. */ }
  finally { if (run === generation) { element('status').textContent = 'Stopped'; busy(false); } }
});
// QA supplies this text through the regular view message surface.
window.netcattyView.onDidReceiveMessage((message) => {
  if (message?.qaFixture === true) element('qa').textContent = 'Isolated QA · deterministic local provider · no model inference or paid API';
});
window.addEventListener('pagehide', () => {
  closed = true; ++generation;
  if (turn) invoke('stop', { turnHandle: turn }).catch(() => {});
  if (chat) invoke('close', { chatHandle: chat.chatHandle }).catch(() => {});
});
void initialize();
