/* global document, window */
'use strict';
const element = (id) => document.getElementById(id);
const invoke = (operation, params = {}) => window.netcattyView.executeCommand(`com.netcatty.assistant.${operation}`, params);
// Follow the same seven public semantic tokens as the other browser samples.
// Only this page's own DOM is updated; no host settings or DOM access is used.
(() => {
  const names = ['--background', '--foreground', '--muted', '--muted-foreground', '--border', '--primary', '--primary-foreground'];
  let subscription;
  const subscribe = () => {
    if (subscription) return;
    subscription = window.netcattyView.onDidChangeEnvironment?.((environment) => {
      const root = document.documentElement;
      const theme = ['light', 'dark'].includes(environment.theme) ? environment.theme : 'system';
      root.dataset.theme = theme;
      root.style.colorScheme = theme === 'system' ? 'light dark' : theme;
      root.dataset.reducedMotion = String(Boolean(environment.reducedMotion));
      root.dataset.highContrast = String(Boolean(environment.highContrast));
      for (const name of names) {
        const value = environment.themeTokens?.[name];
        if (typeof value === 'string' && value.length > 0 && value.length <= 96) root.style.setProperty(name, value);
        else root.style.removeProperty(name);
      }
    });
  };
  subscribe();
  window.addEventListener('pagehide', () => { subscription?.dispose(); subscription = undefined; });
  window.addEventListener('pageshow', subscribe);
})();
let chat;
let turn;
let generation = 0;
let closed = false;
const references = new Map();
function busy(value) {
  element('send').disabled = value || !chat;
  element('stop').disabled = !value;
  element('refresh').disabled = value;
  element('choose-reference').disabled = value;
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
async function selectReferences(run) {
  const summaries = await invoke('contexts');
  if (closed || run !== generation) return false;
  references.clear();
  const placeholder = document.createElement('option');
  placeholder.value = ''; placeholder.textContent = 'No reference';
  element('context').replaceChildren(placeholder);
  for (const reference of summaries) {
    if (reference.scope !== 'note') continue;
    references.set(reference.handle, { handle: reference.handle, version: reference.version, expiresAt: reference.expiresAt });
    const option = document.createElement('option');
    option.value = reference.handle; option.textContent = reference.title;
    element('context').append(option);
  }
  return true;
}
async function initialize() {
  const run = ++generation;
  busy(true);
  try {
    if (!await replaceChat(run)) return;
    if (!await selectReferences(run)) return;
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
element('choose-reference').addEventListener('click', async () => {
  if (closed || element('choose-reference').disabled) return;
  const run = ++generation;
  busy(true); element('status').textContent = 'Choosing reference...';
  try {
    if (await selectReferences(run)) element('status').textContent = 'References updated. Select a reference, then Send.';
  } catch {
    if (run === generation) element('status').textContent = 'Reference selection ended. Choose reference again when access is available.';
  } finally { if (run === generation) busy(false); }
});
element('compose').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!chat || element('send').disabled) return;
  const reference = references.get(element('context').value);
  if (reference && reference.expiresAt <= Date.now()) {
    element('status').textContent = 'Selected reference expired. Choose reference again, then Send.';
    return;
  }
  const run = ++generation;
  busy(true); element('status').textContent = 'Streaming...';
  element('response').textContent = ''; element('usage').textContent = '';
  try {
    // No inference has been requested yet, so an expired session can be
    // replaced before this explicit Send. Never retry a failed send/read.
    if (chat.expiresAt <= Date.now() && !await replaceChat(run)) return;
    const started = await invoke('send', { chatHandle: chat.chatHandle, prompt: element('prompt').value,
      contexts: reference ? [{ handle: reference.handle, version: reference.version }] : [] });
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
    if (run === generation) element('status').textContent = 'Request ended. Check access, choose reference again, or refresh the model before sending again.';
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
