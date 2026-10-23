const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { startPtyJob } = require('./ptyExec.cjs');

class TestPty extends EventEmitter {
  writes = [];
  write(data) {
    this.writes.push(String(data));
    const marker = String(data).match(/(__NCMCP_[a-z0-9]+_[0-9a-f]+__)/i)?.[1];
    if (marker) queueMicrotask(() => this.emit('data', `${marker}_S\nOK\n${marker}_E:0\n`));
  }
}

test('PTY sends no bytes while a slow shell is starting, then runs once ready', async () => {
  const pty = new TestPty();
  let prompt = '';
  const job = startPtyJob(pty, 'echo OK', { shellKind:'posix', getReadyPrompt:()=>prompt, promptWaitTimeoutMs:200, timeoutMs:1000 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(pty.writes, []);
  prompt = 'user@host:~$ ';
  const result = await job.resultPromise;
  assert.equal(result.ok, true);
  assert.equal(pty.writes.length, 1);
});

test('PTY readiness timeout does not send command or interrupt to a busy program', async () => {
  const pty = new TestPty();
  const job = startPtyJob(pty, 'echo OK', { getReadyPrompt:()=>'', promptWaitTimeoutMs:25, timeoutMs:1000 });
  const result = await job.resultPromise;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SHELL_NOT_READY');
  assert.deepEqual(pty.writes, []);
});

test('cancel while waiting for prompt never sends Ctrl+C or a delayed command', async () => {
  const pty = new TestPty();
  let prompt = '';
  const job = startPtyJob(pty, 'echo OK', { getReadyPrompt:()=>prompt, promptWaitTimeoutMs:200, timeoutMs:1000 });
  job.cancel();
  prompt = 'user@host:~$ ';
  const result = await job.resultPromise;
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(result.error, 'Cancelled');
  assert.deepEqual(pty.writes, []);
});

test('closing stream during readiness wait finishes without typing', async () => {
  const pty = new TestPty();
  const job = startPtyJob(pty, 'echo OK', { getReadyPrompt:()=>'', promptWaitTimeoutMs:200, timeoutMs:1000 });
  pty.emit('close');
  assert.equal((await job.resultPromise).ok, false);
  assert.deepEqual(pty.writes, []);
});

test('readiness failure does not echo a command or interrupt a waiting program', async () => {
  const pty = new TestPty();
  const echoes = [];
  const interrupts = [];
  const result = await startPtyJob(pty, 'echo OK', {
    getReadyPrompt: () => '', promptWaitTimeoutMs: 25,
    typedInput: true, echoCommand: value => echoes.push(value),
    onInterrupt: () => interrupts.push(true),
  }).resultPromise;
  assert.equal(result.code, 'SHELL_NOT_READY');
  assert.deepEqual(pty.writes, []);
  assert.deepEqual(echoes, []);
  assert.deepEqual(interrupts, []);
});

test('wall deadline during startup fails without writing or interrupting', async () => {
  const pty = new TestPty();
  const result = await startPtyJob(pty, 'echo OK', {
    getReadyPrompt: () => '', promptWaitTimeoutMs: 1000,
    timeoutMs: 25, enforceWallTimeout: true,
  }).resultPromise;
  assert.equal(result.code, 'SHELL_NOT_READY');
  assert.deepEqual(pty.writes, []);
});

test('a prompt inspection error fails closed without typing', async () => {
  const pty = new TestPty();
  const result = await startPtyJob(pty, 'echo OK', {
    getReadyPrompt: () => { throw new Error('session disappeared'); },
  }).resultPromise;
  assert.equal(result.code, 'SHELL_NOT_READY');
  assert.deepEqual(pty.writes, []);
});
