import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { findTerminalArchives, supportsTerminalArchiveCommands } from './terminalArchives';
import type { Host } from './models';

const host: Host = { id: 'test', label: 'Test', hostname: 'host', username: 'me', tags: [], os: 'linux' };

test('archive commands require known Linux facts, not the default host icon', () => {
  assert.equal(supportsTerminalArchiveCommands(host, 'darwin'), false);
  assert.equal(supportsTerminalArchiveCommands({ ...host, distro: 'ubuntu' }, 'darwin'), true);
  assert.equal(supportsTerminalArchiveCommands({ ...host, osOverride: 'linux' }, 'darwin'), true);
  for (const osOverride of ['unknown', 'windows', 'macos', 'freebsd'] as const) {
    assert.equal(supportsTerminalArchiveCommands({ ...host, osOverride, distro: 'ubuntu' }, 'linux'), false);
  }
  assert.equal(supportsTerminalArchiveCommands({ ...host, distro: 'ubuntu', deviceType: 'network' }, 'linux'), false);
  for (const protocol of ['telnet', 'serial', 'plugin:test'] as const) {
    assert.equal(supportsTerminalArchiveCommands({ ...host, protocol, osOverride: 'linux' }, 'linux'), false);
  }
  assert.equal(supportsTerminalArchiveCommands({ ...host, protocol: 'local' }, 'darwin'), false);
  assert.equal(supportsTerminalArchiveCommands({ ...host, protocol: 'local' }, 'win32'), false);
  assert.equal(supportsTerminalArchiveCommands({ ...host, protocol: 'local' }, 'linux'), true);
});

test('finite tar and zip formats prepare commands without Enter or source deletion', () => {
  const commands = findTerminalArchives('a.tar b.tar.gz c.tgz d.tar.bz2 e.tbz2 f.tar.xz g.txz h.zip').map(x => x.command);
  assert.deepEqual(commands, [
    "tar -xf './a.tar'", "tar -xzf './b.tar.gz'", "tar -xzf './c.tgz'",
    "tar -xjf './d.tar.bz2'", "tar -xjf './e.tbz2'", "tar -xJf './f.tar.xz'", "tar -xJf './g.txz'", "unzip './h.zip'",
  ]);
  assert.deepEqual(findTerminalArchives('a.gz b.rar c.7z tool.exe https://host/a.zip'), []);
  assert.ok(commands.every(command => !/[\r\n]/u.test(command)));
});

test('quoted filenames, Unicode and leading options remain literal shell arguments', () => {
  const text = `输出 "it's $(touch NO).tar.gz" '-options.zip' /opt/文件.tar ~/backup.zip`;
  const matches = findTerminalArchives(text);
  assert.equal(matches.length, 4);
  for (const match of matches) assert.equal(text.slice(match.start, match.start + match.length), match.text);
  const expected = ["./it's $(touch NO).tar.gz", './-options.zip', '/opt/文件.tar', `${process.env.HOME}/backup.zip`];
  for (let i = 0; i < matches.length; i++) {
    // Substitute only the fixed extractor name/options with printf: a real POSIX
    // shell must see the original filename as exactly one literal argument.
    const argument = matches[i].command.replace(/^(?:tar -x[zjJ]?f|unzip) /, '');
    assert.equal(execFileSync('/bin/sh', ['-c', `printf '%s' ${argument}`], { encoding: 'utf8' }), expected[i]);
  }
});

test('does not guess partial tokens inside malformed quotes or include control characters', () => {
  assert.deepEqual(findTerminalArchives('"unfinished.tar.gz'), []);
  assert.deepEqual(findTerminalArchives('file\u001b.tar.gz'), []);
  assert.deepEqual(findTerminalArchives('"http://example.com/my archive.zip"'), []);
});
