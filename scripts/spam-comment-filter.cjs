"use strict";

const TRUSTED_AUTHOR_ASSOCIATIONS = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);

const RISKY_EXTENSIONS = [
  ".tar.gz",
  ".tar.xz",
  ".appimage",
  ".msix",
  ".zip",
  ".7z",
  ".rar",
  ".tgz",
  ".exe",
  ".msi",
  ".dmg",
  ".pkg",
  ".deb",
  ".rpm",
  ".bat",
  ".cmd",
  ".ps1",
  ".scr",
  ".vbs",
  ".jar",
  ".iso",
  ".lnk",
];

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;

function normalizeAssociation(authorAssociation) {
  return String(authorAssociation || "").trim().toUpperCase();
}

function isTrustedAuthor(authorAssociation) {
  return TRUSTED_AUTHOR_ASSOCIATIONS.has(normalizeAssociation(authorAssociation));
}

function isSameLogin(left, right) {
  const a = String(left || "").trim().toLowerCase();
  const b = String(right || "").trim().toLowerCase();
  return a.length > 0 && a === b;
}

function trimUrlCandidate(raw) {
  let value = String(raw || "");
  while (value.length > 0) {
    const last = value[value.length - 1];
    if (".,;:!?\"']".includes(last)) {
      value = value.slice(0, -1);
      continue;
    }
    if (last === ")") {
      const opens = (value.match(/\(/g) || []).length;
      const closes = (value.match(/\)/g) || []).length;
      if (closes > opens) {
        value = value.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return value;
}

function hasRiskyExtension(segment) {
  const name = String(segment || "").toLowerCase();
  if (!name || name === "." || name === "..") return false;
  return RISKY_EXTENSIONS.some((extension) => name.endsWith(extension));
}

function urlHasRiskyPath(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

  let pathname = parsed.pathname || "";
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // Keep the raw pathname when it is not valid percent-encoding.
  }

  return pathname.split("/").some((segment) => hasRiskyExtension(segment));
}

function extractRiskyUrls(body) {
  const text = String(body || "");
  const found = [];
  const seen = new Set();
  for (const match of text.matchAll(URL_PATTERN)) {
    const raw = trimUrlCandidate(match[0]);
    if (!raw || seen.has(raw) || !urlHasRiskyPath(raw)) continue;
    seen.add(raw);
    found.push(raw);
  }
  return found;
}

function detectSpamComment({
  body,
  authorAssociation,
  userType,
  commentAuthor,
  issueAuthor,
} = {}) {
  const trustedAuthor = isTrustedAuthor(authorAssociation);
  const botAuthor = String(userType || "").trim().toLowerCase() === "bot";
  const authorIsIssueAuthor = isSameLogin(commentAuthor, issueAuthor);
  const matchedUrls = extractRiskyUrls(body);

  // Hard rule: hide when an untrusted human who is not the issue author posts
  // an http(s) URL whose path contains a risky archive or executable.
  // Maintainers, bots, and the issue author are exempt. Bare filenames and
  // local paths are not links, so they do not match.
  const spam =
    !trustedAuthor &&
    !botAuthor &&
    !authorIsIssueAuthor &&
    matchedUrls.length > 0;

  return {
    spam,
    score: spam ? 10 : 0,
    reasons: spam ? [`risky download URL: ${matchedUrls.join(", ")}`] : [],
    matchedUrls,
    trustedAuthor,
    botAuthor,
    authorIsIssueAuthor,
  };
}

module.exports = {
  detectSpamComment,
  extractRiskyUrls,
  isTrustedAuthor,
  RISKY_EXTENSIONS,
};
