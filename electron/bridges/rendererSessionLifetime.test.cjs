const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const test = require("node:test");
const { trackRendererSessionLifetime: track } = require("./rendererSessionLifetime.cjs");

function renderer(id) {
  const contents = new EventEmitter();
  contents.id = id;
  contents.destroyed = false;
  contents.isDestroyed = () => contents.destroyed;
  contents.destroy = () => { contents.destroyed = true; contents.emit("destroyed"); };
  return contents;
}

function fixture() {
  const sessions = new Map();
  const closed = [];
  const close = (_event, payload) => { closed.push(payload); sessions.delete(payload.sessionId); };
  const own = (id, contents, bootEpoch = 1) => {
    sessions.set(id, { bootEpoch });
    track(sessions, id, contents, close);
  };
  return { sessions, closed, close, own };
}

test("fallback closes only session objects owned by the destroyed renderer", () => {
  const f = fixture();
  const first = renderer(7), second = renderer(8);
  f.own("a", first);
  f.own("b", first);
  f.own("c", second);
  assert.equal(first.listenerCount("destroyed"), 1);
  first.destroy();
  assert.deepEqual(f.closed, [{ sessionId: "a", bootEpoch: 1 }, { sessionId: "b", bootEpoch: 1 }]);
  assert.equal(f.sessions.has("c"), true);
});

test("fallback display rebind is not an ownership handoff; explicit home restore is", () => {
  const f = fixture();
  const home = renderer(7), popup = renderer(9), nextHome = renderer(8);
  f.own("a", home);
  track(f.sessions, "a", popup, f.close);
  popup.destroy();
  assert.equal(f.closed.length, 0);
  track(f.sessions, "a", nextHome, f.close, true);
  home.destroy();
  assert.equal(f.closed.length, 0);
  nextHome.destroy();
  assert.equal(f.closed.length, 1);
});

test("fallback old owner cannot close a same-ID replacement or synthetic agent session", () => {
  const f = fixture();
  const home = renderer(7), nextHome = renderer(8);
  f.own("a", home);
  f.own("a", nextHome, 2);
  f.own("agent", { id: 7 });
  home.destroy();
  assert.equal(f.closed.length, 0);
  nextHome.destroy();
  assert.deepEqual(f.closed, [{ sessionId: "a", bootEpoch: 2 }]);
  assert.equal(f.sessions.has("agent"), true);
});

test("fallback late start into a destroyed renderer closes after setup, not a replacement", async () => {
  const f = fixture();
  const home = renderer(7), nextHome = renderer(8);
  home.destroy();
  f.own("late", home);
  assert.equal(f.closed.length, 0);
  await Promise.resolve();
  assert.deepEqual(f.closed, [{ sessionId: "late", bootEpoch: 1 }]);
  f.own("replacement", home);
  f.own("replacement", nextHome, 2);
  await Promise.resolve();
  assert.equal(f.closed.length, 1);
  assert.equal(f.sessions.has("replacement"), true);
});
