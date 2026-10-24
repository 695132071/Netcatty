import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { isSerialEndpointPath, isWindowsNamedPipePath } from './serialEndpoint';
const require = createRequire(import.meta.url);
const backend = require('../electron/bridges/serialNamedPipe.cjs');

test('serial endpoint validation keeps hardware ports and accepts local Windows pipes', () => {
  for (const value of ['/dev/ttyS0', '/dev/ttys001', 'COM1', String.raw`\\.\COM12`, String.raw`\\.\pipe\vm`, String.raw`\\?\pipe\vm`]) {
    assert.equal(isSerialEndpointPath(value), true, value);
  }
  for (const value of ['', 'vm', '\\\\.\\pipe\\', String.raw`\\host\pipe\vm`]) {
    assert.equal(isSerialEndpointPath(value), false, value);
  }
});

test('renderer and backend agree on named pipe detection', () => {
  for (const value of ['', '/dev/ttyS0', 'COM1', String.raw`\\.\COM1`, String.raw`\\.\pipe\vm`, String.raw`\\?\pipe\VM console`, String.raw`\\.\PIPE\vm\console`, String.raw`\\host\pipe\vm`, '\\\\.\\pipe\\', '\\\\.\\pipe\\vm\n', '\\\\.\\pipe\\vm\0']) {
    assert.equal(isWindowsNamedPipePath(value), backend.isWindowsNamedPipePath(value), value);
  }
});
