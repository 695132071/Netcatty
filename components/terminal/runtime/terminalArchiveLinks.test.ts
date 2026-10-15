import test from 'node:test';
import assert from 'node:assert/strict';
import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm';
import { registerTerminalArchiveLinks } from './terminalArchiveLinks';

function fixture() {
  let provider!: ILinkProvider;
  let text = 'backup.tar.gz';
  let enabled = true, ready = true, registrationDisposed = false, wrapped = false;
  const pasted: string[] = [];
  let submitted: (data: string) => void = () => {};
  let markerLine = -1;
  const term = {
    buffer: { active: { getLine: (y: number) => y === 0 ? { translateToString: () => text, isWrapped: wrapped } : undefined } },
    paste: (value: string) => { pasted.push(value); ready = false; },
    focus: () => {},
    registerMarker: () => ({ line: markerLine, isDisposed: false, dispose() { this.isDisposed = true; } }),
    onData: (listener: (data: string) => void) => { submitted = listener; return { dispose() {} }; },
    registerLinkProvider: (next: ILinkProvider) => { provider = next; return { dispose: () => { registrationDisposed = true; } }; },
  };
  const registration = registerTerminalArchiveLinks({ term: term as unknown as Terminal, isEnabled: () => enabled, isInputReady: () => ready });
  const links = () => { let value: ILink[] | undefined; provider.provideLinks(1, result => { value = result; }); return value; };
  return { links, pasted, registration, submit: () => { markerLine = 0; submitted('\r'); }, setText: (value: string) => { text = value; }, setReady: (value: boolean) => { ready = value; }, setEnabled: (value: boolean) => { enabled = value; }, setWrapped: () => { wrapped = true; }, isDisposed: () => registrationDisposed };
}

const ctrlClick = { button: 0, ctrlKey: true } as MouseEvent;

test('Ctrl+left click prepares exactly one command without Enter; ordinary click does nothing', () => {
  const f = fixture(), link = f.links()![0];
  assert.deepEqual(link.range, { start: { x: 1, y: 1 }, end: { x: 13, y: 1 } });
  link.activate({ button: 0, ctrlKey: false } as MouseEvent, link.text);
  assert.deepEqual(f.pasted, []);
  link.activate(ctrlClick, link.text);
  link.activate(ctrlClick, link.text);
  assert.deepEqual(f.pasted, ["tar -xzf './backup.tar.gz'"]);
});

test('live readiness/platform checks preserve a draft even for cached links', () => {
  const f = fixture(), link = f.links()![0];
  f.setReady(false);
  assert.equal(f.links(), undefined);
  link.activate(ctrlClick, link.text);
  f.setReady(true); f.setEnabled(false);
  link.activate(ctrlClick, link.text);
  assert.deepEqual(f.pasted, []);
});

test('stale output and disposed links cannot prepare commands; wrapped fragments are excluded', () => {
  const f = fixture(), link = f.links()![0];
  f.setText('changed.tar.gz'); link.activate(ctrlClick, link.text);
  assert.deepEqual(f.pasted, []);
  f.setWrapped(); assert.equal(f.links(), undefined);
  f.registration.dispose(); assert.equal(f.isDisposed(), true);
  link.activate(ctrlClick, link.text); assert.deepEqual(f.pasted, []);
});

test('submitting another command invalidates old relative names and cached links, but not absolute paths', () => {
  const f = fixture(), link = f.links()![0];
  f.submit();
  assert.deepEqual(f.links(), []);
  link.activate(ctrlClick, link.text);
  assert.deepEqual(f.pasted, []);
  f.setText('/tmp/backup.tar.gz');
  const absolute = f.links()![0];
  absolute.activate(ctrlClick, absolute.text);
  assert.deepEqual(f.pasted, ["tar -xzf '/tmp/backup.tar.gz'"]);
});
