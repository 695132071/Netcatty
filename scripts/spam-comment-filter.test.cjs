"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { detectSpamComment, extractRiskyUrls } = require("./spam-comment-filter.cjs");

test("issue author pasting a local SecureCRT.exe path is not hidden", () => {
  const result = detectSpamComment({
    authorAssociation: "NONE",
    userType: "User",
    commentAuthor: "reporter",
    issueAuthor: "reporter",
    body: "It crashes here: C:\\Program Files\\SecureCRT\\SecureCRT.exe",
  });

  assert.equal(result.spam, false);
  assert.deepEqual(result.matchedUrls, []);
});

test("bare Windows path without a URL is not hidden even from a third party", () => {
  const result = detectSpamComment({
    authorAssociation: "NONE",
    userType: "User",
    commentAuthor: "mallory",
    issueAuthor: "reporter",
    body: "Try Files\\SecureCRT\\SecureCRT.exe and also hotfix.dmg.",
  });

  assert.equal(result.spam, false);
  assert.deepEqual(result.matchedUrls, []);
});

test("third party github user-attachments zip URL is hidden", () => {
  const result = detectSpamComment({
    authorAssociation: "NONE",
    userType: "User",
    commentAuthor: "mallory",
    issueAuthor: "reporter",
    body: "Grab https://github.com/user-attachments/files/123/fix.zip and run it.",
  });

  assert.equal(result.spam, true);
  assert.deepEqual(result.matchedUrls, [
    "https://github.com/user-attachments/files/123/fix.zip",
  ]);
});

test("third party mediafire zip URL is hidden when the extension is a path segment", () => {
  const result = detectSpamComment({
    authorAssociation: "NONE",
    userType: "User",
    commentAuthor: "mallory",
    issueAuthor: "reporter",
    body: "Download https://www.mediafire.com/file/abc/netcatty_fix.zip/file",
  });

  assert.equal(result.spam, true);
  assert.deepEqual(result.matchedUrls, [
    "https://www.mediafire.com/file/abc/netcatty_fix.zip/file",
  ]);
});

test("maintainer posting a release dmg link is not hidden", () => {
  const result = detectSpamComment({
    authorAssociation: "OWNER",
    userType: "User",
    commentAuthor: "maintainer",
    issueAuthor: "reporter",
    body: "Signed build: https://github.com/binaricat/Netcatty/releases/download/v1.2.3/Netcatty.dmg",
  });

  assert.equal(result.spam, false);
  assert.equal(result.trustedAuthor, true);
  assert.deepEqual(result.matchedUrls, [
    "https://github.com/binaricat/Netcatty/releases/download/v1.2.3/Netcatty.dmg",
  ]);
});

test("issue author uploading their own repro zip is not hidden", () => {
  const result = detectSpamComment({
    authorAssociation: "NONE",
    userType: "User",
    commentAuthor: "Reporter",
    issueAuthor: "reporter",
    body: "[repro.zip](https://github.com/user-attachments/files/99/repro.zip)",
  });

  assert.equal(result.spam, false);
  assert.equal(result.authorIsIssueAuthor, true);
  assert.deepEqual(result.matchedUrls, [
    "https://github.com/user-attachments/files/99/repro.zip",
  ]);
});

test("query strings do not block a risky path, and a query-only filename does not match", () => {
  assert.deepEqual(
    extractRiskyUrls("https://example.com/dropper.exe?download=1&arch=win"),
    ["https://example.com/dropper.exe?download=1&arch=win"]
  );
  assert.deepEqual(
    extractRiskyUrls("https://example.com/download?file=fix.zip"),
    []
  );
});

test("matches newly added extensions and ignores non-risky links", () => {
  const body = [
    "https://example.com/a.jar",
    "https://example.com/b.iso",
    "https://example.com/c.msix",
    "https://example.com/d.lnk",
    "https://example.com/e.tar.xz",
    "https://example.com/f.tar.gz",
    "https://github.com/user-attachments/assets/e1302660-dece-46be-9857-1678a9b13d00",
    "https://example.com/package.json",
    "https://example.com/notes.zip.txt",
  ].join("\n");

  assert.deepEqual(extractRiskyUrls(body), [
    "https://example.com/a.jar",
    "https://example.com/b.iso",
    "https://example.com/c.msix",
    "https://example.com/d.lnk",
    "https://example.com/e.tar.xz",
    "https://example.com/f.tar.gz",
  ]);
});

test("member and collaborator exemptions still apply to http links", () => {
  for (const authorAssociation of ["MEMBER", "COLLABORATOR"]) {
    const result = detectSpamComment({
      authorAssociation,
      userType: "User",
      commentAuthor: "maintainer",
      issueAuthor: "reporter",
      body: "Mirror: http://example.com/setup.msi",
    });
    assert.equal(result.spam, false);
    assert.deepEqual(result.matchedUrls, ["http://example.com/setup.msi"]);
  }
});

test("does not flag bot comments that include a risky URL", () => {
  const result = detectSpamComment({
    authorAssociation: "NONE",
    userType: "Bot",
    commentAuthor: "netcatty[bot]",
    issueAuthor: "reporter",
    body: "Uploaded https://example.com/build-artifacts.zip for CI.",
  });

  assert.equal(result.spam, false);
  assert.equal(result.botAuthor, true);
});

test("strips markdown and sentence punctuation around the URL", () => {
  assert.deepEqual(
    extractRiskyUrls("See [patch](https://example.com/patch.zip). Thanks!"),
    ["https://example.com/patch.zip"]
  );
  assert.deepEqual(
    extractRiskyUrls("<https://example.com/tool.EXE>"),
    ["https://example.com/tool.EXE"]
  );
});
