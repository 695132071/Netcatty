import assert from "node:assert/strict";
import test from "node:test";
import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";

import { createTerminalCwdMarkers } from "./terminalCwdMarkers.ts";
import { registerTerminalArchiveLinks } from "./terminalArchiveLinks.ts";
import type { LinkModifier } from "../../../domain/models/terminal.ts";

type PrintedLine = { text: string; wrapped: boolean };

function click(partial: Partial<MouseEvent> = {}): MouseEvent {
  return {
    button: 0,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    ...partial,
  } as MouseEvent;
}

function makeBufferLine(line: PrintedLine) {
  const chars = Array.from(line.text);
  return {
    isWrapped: line.wrapped,
    length: chars.length,
    translateToString(trim?: boolean) {
      return trim ? line.text.trimEnd() : line.text;
    },
    getCell(index: number) {
      const ch = chars[index];
      if (ch === undefined) return undefined;
      return {
        getChars: () => ch,
        getWidth: () => 1,
      };
    },
  };
}

function fixture() {
  let lines: PrintedLine[] = [{ text: "/tmp/backup.tar.gz", wrapped: false }];
  let cursorX = 0;
  let cursorY = 0;
  let baseY = 0;
  let cols = 80;
  let cursorLine = 0;
  let type: "normal" | "alternate" = "normal";
  let connected = true;
  let broadcast = false;
  let eligible = true;
  let ready = true;
  let modifier: LinkModifier = "none";
  const pasted: string[] = [];
  let provider!: ILinkProvider;

  const term = {
    get cols() {
      return cols;
    },
    buffer: {
      active: {
        get type() {
          return type;
        },
        get cursorX() {
          return cursorX;
        },
        get cursorY() {
          return cursorY;
        },
        get baseY() {
          return baseY;
        },
        getLine(index: number) {
          const line = lines[index];
          return line ? makeBufferLine(line) : undefined;
        },
      },
    },
    registerMarker(offset: number) {
      return {
        line: cursorLine + offset,
        isDisposed: false,
        dispose() {
          this.isDisposed = true;
        },
      };
    },
    paste(value: string) {
      pasted.push(value);
    },
    focus() {},
    registerLinkProvider(next: ILinkProvider) {
      provider = next;
      return { dispose() {} };
    },
  };

  const cwdMarkers = createTerminalCwdMarkers(term as never);
  registerTerminalArchiveLinks({
    term: term as unknown as Terminal,
    cwdMarkers,
    isConnected: () => connected,
    isBroadcasting: () => broadcast,
    isHostEligible: () => eligible,
    isInputReady: () => ready,
    linkModifier: () => modifier,
  });

  const linksAt = (y: number) => {
    let value: ILink[] | undefined;
    provider.provideLinks(y, (result) => {
      value = result;
    });
    return value;
  };

  return {
    pasted,
    linksAt,
    noteAt(line: number, report: { cwd: string; host: string }, x = 0) {
      cursorLine = line;
      const previousX = cursorX;
      cursorX = x;
      cwdMarkers.note(report);
      cursorX = previousX;
    },
    setLines(next: PrintedLine[]) {
      lines = next;
    },
    setLine(index: number, text: string, wrapped = false) {
      lines[index] = { text, wrapped };
    },
    setCursor(line: number, x: number) {
      cursorY = line;
      cursorX = x;
      baseY = 0;
    },
    atPrompt() {
      const prompt = lines.length;
      lines = [...lines, { text: "", wrapped: false }];
      cursorY = prompt;
      cursorX = 0;
      baseY = 0;
    },
    setBroadcast(value: boolean) {
      broadcast = value;
    },
    setReady(value: boolean) {
      ready = value;
    },
    setEligible(value: boolean) {
      eligible = value;
    },
    setConnected(value: boolean) {
      connected = value;
    },
    setModifier(value: LinkModifier) {
      modifier = value;
    },
    setAltBuffer(value: boolean) {
      type = value ? "alternate" : "normal";
    },
  };
}

const ctrl = click({ ctrlKey: true });

test("no modifier is a no-op, Ctrl fills one command, and Cmd works on macOS", () => {
  const linux = fixture();
  const link = linux.linksAt(1)?.[0];
  assert.ok(link);
  assert.deepEqual(link.range, { start: { x: 1, y: 1 }, end: { x: 18, y: 1 } });
  linux.atPrompt();
  link.activate(click(), link.text);
  assert.deepEqual(linux.pasted, []);
  link.activate(ctrl, link.text);
  assert.deepEqual(linux.pasted, ["tar -xvzf '/tmp/backup.tar.gz' -C '/tmp'"]);
  assert.equal(linux.pasted[0]?.includes("\r"), false);
  assert.equal(linux.pasted[0]?.includes("\n"), false);

  const mac = fixture();
  const macLink = mac.linksAt(1)?.[0];
  assert.ok(macLink);
  mac.atPrompt();
  macLink.activate(click({ metaKey: true }), macLink.text);
  assert.deepEqual(mac.pasted, ["tar -xvzf '/tmp/backup.tar.gz' -C '/tmp'"]);
});

test("a configured alt modifier is required for archive links", () => {
  const f = fixture();
  f.setModifier("alt");
  const link = f.linksAt(1)?.[0];
  assert.ok(link);
  link.activate(ctrl, link.text);
  assert.deepEqual(f.pasted, []);
  link.activate(click({ altKey: true }), link.text);
  assert.equal(f.pasted.length, 1);
  assert.equal(f.pasted[0]?.includes("\r"), false);
});

test("broadcast, readiness, host eligibility, buffer, and stale text gate provide and activate", () => {
  const f = fixture();
  const link = f.linksAt(1)?.[0];
  assert.ok(link);

  f.setBroadcast(true);
  assert.equal(f.linksAt(1), undefined);
  link.activate(ctrl, link.text);
  f.setBroadcast(false);

  f.setReady(false);
  assert.equal(f.linksAt(1), undefined);
  link.activate(ctrl, link.text);
  f.setReady(true);

  f.setEligible(false);
  assert.equal(f.linksAt(1), undefined);
  link.activate(ctrl, link.text);
  f.setEligible(true);

  f.setConnected(false);
  assert.equal(f.linksAt(1), undefined);
  link.activate(ctrl, link.text);
  f.setConnected(true);

  f.setAltBuffer(true);
  assert.equal(f.linksAt(1), undefined);
  link.activate(ctrl, link.text);
  f.setAltBuffer(false);

  f.setLine(0, "changed.tar.gz");
  link.activate(ctrl, link.text);
  assert.deepEqual(f.pasted, []);
});

test("a non-space before the cursor is kept and separated with one space", () => {
  const draft = fixture();
  draft.setLines([
    { text: "/tmp/backup.tar.gz", wrapped: false },
    { text: "echo", wrapped: false },
  ]);
  draft.setCursor(1, 4);
  const link = draft.linksAt(1)?.[0];
  assert.ok(link);
  link.activate(ctrl, link.text);
  assert.equal(draft.pasted[0], " tar -xvzf '/tmp/backup.tar.gz' -C '/tmp'");

  const spaced = fixture();
  spaced.setLines([
    { text: "/tmp/backup.tar.gz", wrapped: false },
    { text: "sudo ", wrapped: false },
  ]);
  spaced.setCursor(1, 5);
  const spacedLink = spaced.linksAt(1)?.[0];
  assert.ok(spacedLink);
  spacedLink.activate(ctrl, spacedLink.text);
  assert.equal(spaced.pasted[0], "tar -xvzf '/tmp/backup.tar.gz' -C '/tmp'");
});

test("a non-space after the cursor is separated with one space", () => {
  const command = "tar -xvzf '/tmp/backup.tar.gz' -C '/tmp'";
  const before = fixture();
  before.setLines([
    { text: "/tmp/backup.tar.gz", wrapped: false },
    { text: "echo", wrapped: false },
  ]);
  before.setCursor(1, 0);
  const beforeLink = before.linksAt(1)?.[0];
  assert.ok(beforeLink);
  beforeLink.activate(ctrl, beforeLink.text);
  assert.equal(before.pasted[0], `${command} `);
  assert.equal(before.pasted[0]?.includes("\r"), false);

  const middle = fixture();
  middle.setLines([
    { text: "/tmp/backup.tar.gz", wrapped: false },
    { text: "echo", wrapped: false },
  ]);
  middle.setCursor(1, 2);
  const middleLink = middle.linksAt(1)?.[0];
  assert.ok(middleLink);
  middleLink.activate(ctrl, middleLink.text);
  assert.equal(middle.pasted[0], ` ${command} `);

  const already = fixture();
  already.setLines([
    { text: "/tmp/backup.tar.gz", wrapped: false },
    { text: "echo foo", wrapped: false },
  ]);
  already.setCursor(1, 4);
  const alreadyLink = already.linksAt(1)?.[0];
  assert.ok(alreadyLink);
  alreadyLink.activate(ctrl, alreadyLink.text);
  assert.equal(already.pasted[0], ` ${command}`);
});

test("a wrapped draft separates the command from the previous row", () => {
  const command = "tar -xvzf '/tmp/backup.tar.gz' -C '/tmp'";
  const full = " ".repeat(79);

  const glued = fixture();
  glued.setLines([
    { text: "/tmp/backup.tar.gz", wrapped: false },
    { text: `${full}o`, wrapped: false },
    { text: " ", wrapped: true },
  ]);
  glued.setCursor(2, 0);
  const gluedLink = glued.linksAt(1)?.[0];
  assert.ok(gluedLink);
  gluedLink.activate(ctrl, gluedLink.text);
  assert.equal(glued.pasted[0], ` ${command}`);

  const spaced = fixture();
  spaced.setLines([
    { text: "/tmp/backup.tar.gz", wrapped: false },
    { text: `${full} `, wrapped: false },
    { text: " ", wrapped: true },
  ]);
  spaced.setCursor(2, 0);
  const spacedLink = spaced.linksAt(1)?.[0];
  assert.ok(spacedLink);
  spacedLink.activate(ctrl, spacedLink.text);
  assert.equal(spaced.pasted[0], command);

  const separate = fixture();
  separate.setLines([
    { text: "/tmp/backup.tar.gz", wrapped: false },
    { text: `${full}o`, wrapped: false },
    { text: " ", wrapped: false },
  ]);
  separate.setCursor(2, 0);
  const separateLink = separate.linksAt(1)?.[0];
  assert.ok(separateLink);
  separateLink.activate(ctrl, separateLink.text);
  assert.equal(separate.pasted[0], command);

  const continued = fixture();
  continued.setLines([
    { text: "/tmp/backup.tar.gz", wrapped: false },
    { text: "e".repeat(80), wrapped: false },
    { text: "x", wrapped: true },
  ]);
  continued.setCursor(1, 80);
  const continuedLink = continued.linksAt(1)?.[0];
  assert.ok(continuedLink);
  continuedLink.activate(ctrl, continuedLink.text);
  assert.equal(continued.pasted[0], ` ${command} `);
});

test("a name that starts on the next wrapped row is not anchored on the previous row", () => {
  const f = fixture();
  f.setLines([
    { text: "x ", wrapped: false },
    { text: "/tmp/a.tar", wrapped: true },
  ]);
  const link = f.linksAt(1)?.[0];
  assert.ok(link);
  assert.equal(link.text, "/tmp/a.tar");
  assert.deepEqual(link.range, {
    start: { x: 1, y: 2 },
    end: { x: 10, y: 2 },
  });

  const ended = fixture();
  ended.setLines([
    { text: "/a.tar", wrapped: false },
    { text: " rest", wrapped: true },
  ]);
  const endedLink = ended.linksAt(1)?.[0];
  assert.ok(endedLink);
  assert.equal(endedLink.text, "/a.tar");
  assert.deepEqual(endedLink.range, {
    start: { x: 1, y: 1 },
    end: { x: 6, y: 1 },
  });
});

test("a wrapped logical line is one multi-row link and fills the full path", () => {
  const f = fixture();
  f.setLines([
    { text: "/tmp/back", wrapped: false },
    { text: "up.tar.gz", wrapped: true },
  ]);
  const link = f.linksAt(1)?.[0];
  assert.ok(link);
  assert.deepEqual(link.range, {
    start: { x: 1, y: 1 },
    end: { x: 9, y: 2 },
  });
  f.atPrompt();
  link.activate(ctrl, link.text);
  assert.deepEqual(f.pasted, ["tar -xvzf '/tmp/backup.tar.gz' -C '/tmp'"]);
});

test("absolute names link without markers and relative names do not", () => {
  const relative = fixture();
  relative.setLine(0, "bundle.tar.gz");
  assert.equal(relative.linksAt(1), undefined);

  const absolute = fixture();
  absolute.setLine(0, "/var/pack.zip");
  const link = absolute.linksAt(1)?.[0];
  assert.ok(link);
  absolute.atPrompt();
  link.activate(ctrl, link.text);
  assert.deepEqual(absolute.pasted, ["unzip '/var/pack.zip' -d '/var'"]);

  const open = fixture();
  open.setLines([
    { text: "prompt", wrapped: false },
    { text: "/var/pack.zip", wrapped: false },
  ]);
  open.noteAt(0, { cwd: "/var", host: "box" });
  const openLink = open.linksAt(2)?.[0];
  assert.ok(openLink);
  open.atPrompt();
  openLink.activate(ctrl, openLink.text);
  assert.equal(open.pasted[0], "unzip '/var/pack.zip' -d '/var'");
  open.setLine(1, "pack.zip");
  assert.equal(open.linksAt(2), undefined);

  const mismatched = fixture();
  mismatched.setLines([
    { text: "prompt", wrapped: false },
    { text: "/tmp/a.tar.gz", wrapped: false },
    { text: "prompt", wrapped: false },
  ]);
  mismatched.noteAt(0, { cwd: "/tmp", host: "box" });
  mismatched.noteAt(2, { cwd: "/other", host: "box" });
  const mismatchLink = mismatched.linksAt(2)?.[0];
  assert.ok(mismatchLink);
  mismatched.atPrompt();
  mismatchLink.activate(ctrl, mismatchLink.text);
  assert.equal(mismatched.pasted[0], "tar -xvzf '/tmp/a.tar.gz' -C '/tmp'");
  mismatched.setLine(1, "a.tar.gz");
  assert.equal(mismatched.linksAt(2), undefined);
});

test("an absolute path from another host is not a link", () => {
  const f = fixture();
  f.setLines([
    { text: "prompt", wrapped: false },
    { text: "/tmp/a.tar.gz", wrapped: false },
    { text: "prompt", wrapped: false },
  ]);
  f.noteAt(0, { cwd: "/tmp", host: "outer" });
  f.noteAt(2, { cwd: "/tmp", host: "outer" });
  f.noteAt(4, { cwd: "/home", host: "inner" });
  assert.equal(f.linksAt(2), undefined);
});

test("ls -l links only the archive name and a symlink line links both names", () => {
  const listing = fixture();
  listing.setLines([
    { text: "$ ls -l", wrapped: false },
    { text: "-rw-r--r-- 1 me me 10 Jan 1 00:00 bundle.tar.gz", wrapped: false },
    { text: "$", wrapped: false },
  ]);
  listing.noteAt(0, { cwd: "/data", host: "box" });
  listing.noteAt(2, { cwd: "/data", host: "box" });
  const links = listing.linksAt(2);
  assert.deepEqual(links?.map((link) => link.text), ["bundle.tar.gz"]);
  listing.atPrompt();
  links?.[0]?.activate(ctrl, links[0].text);
  assert.deepEqual(listing.pasted, ["tar -xvzf '/data/bundle.tar.gz' -C '/data'"]);

  const symlink = fixture();
  symlink.setLines([
    { text: "$ ls", wrapped: false },
    { text: "a.tar.gz -> b.tar.gz", wrapped: false },
    { text: "$", wrapped: false },
  ]);
  symlink.noteAt(0, { cwd: "/data", host: "box" });
  symlink.noteAt(2, { cwd: "/data", host: "box" });
  assert.deepEqual(symlink.linksAt(2)?.map((link) => link.text), ["a.tar.gz", "b.tar.gz"]);
});
