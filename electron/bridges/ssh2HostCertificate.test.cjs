"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  DEFAULT_SERVER_HOST_KEY,
  SUPPORTED_SERVER_HOST_KEY,
} = require("ssh2/lib/protocol/constants.js");
const {
  parseDERKey,
  parseKey,
} = require("ssh2/lib/protocol/keyParser.js");
const {
  hostKeyBlobTypeAccepted,
  hostKeySignatureTypeAccepted,
} = require("ssh2/lib/protocol/kex.js");

// Manual live check (optional; needs network and real Instabox credentials):
//   ssh -vv -p 2222 USER@ssh.instabox.sh
// Instabox advertises only ssh-ed25519-cert-v01@openssh.com and signs the
// exchange hash as ssh-ed25519. After this patch, host-key negotiation should
// succeed; authentication still depends on the real certificate credentials.

const HOST_CERT = "ssh-ed25519-cert-v01@openssh.com";
const HOST_CERT_ALGORITHMS = [
  HOST_CERT,
  "ecdsa-sha2-nistp256-cert-v01@openssh.com",
  "ecdsa-sha2-nistp384-cert-v01@openssh.com",
  "ecdsa-sha2-nistp521-cert-v01@openssh.com",
  "rsa-sha2-512-cert-v01@openssh.com",
  "rsa-sha2-256-cert-v01@openssh.com",
  "ssh-rsa-cert-v01@openssh.com",
];

function sshKeygenSkipReason(error) {
  if (error && error.code === "ENOENT")
    return "ssh-keygen is not installed";
  return false;
}

function detectSshKeygenSkip() {
  try {
    execFileSync("ssh-keygen", ["-h"], { stdio: "ignore" });
    return false;
  } catch (error) {
    return sshKeygenSkipReason(error);
  }
}

const sshKeygenSkip = detectSshKeygenSkip();

function mintEd25519HostCert(dir) {
  const ca = path.join(dir, "ca");
  const host = path.join(dir, "host");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", ca]);
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", host]);
  execFileSync("ssh-keygen", [
    "-q",
    "-s",
    ca,
    "-I",
    "netcatty-hostcert",
    "-h",
    "-n",
    "127.0.0.1",
    "-V",
    "+52w",
    `${host}.pub`,
  ]);
  const certLine = fs.readFileSync(`${host}-cert.pub`, "utf8").trim();
  const [type, b64] = certLine.split(/\s+/);
  const privateKey = parseKey(fs.readFileSync(host));
  return {
    type,
    certBlob: Buffer.from(b64, "base64"),
    privateKeyPem: fs.readFileSync(host),
    privateKey,
  };
}

test("ssh2 default and supported host key lists offer OpenSSH host certificates", () => {
  for (const algo of HOST_CERT_ALGORITHMS) {
    assert.equal(DEFAULT_SERVER_HOST_KEY.includes(algo), true, `${algo} missing from defaults`);
    assert.equal(SUPPORTED_SERVER_HOST_KEY.includes(algo), true, `${algo} missing from supported`);
  }
  assert.ok(
    DEFAULT_SERVER_HOST_KEY.indexOf(HOST_CERT) < DEFAULT_SERVER_HOST_KEY.indexOf("ssh-ed25519"),
    "host certificates should be offered before the matching plain key",
  );
  assert.equal(DEFAULT_SERVER_HOST_KEY.includes("ssh-ed25519"), true);
  assert.equal(DEFAULT_SERVER_HOST_KEY.includes("ssh-rsa"), true);
  assert.equal(
    SUPPORTED_SERVER_HOST_KEY.includes("sk-ssh-ed25519-cert-v01@openssh.com"),
    true,
  );
  assert.equal(
    SUPPORTED_SERVER_HOST_KEY.includes("sk-ecdsa-sha2-nistp256-cert-v01@openssh.com"),
    true,
  );
});

test("missing ssh-keygen skips host-certificate minting instead of failing", () => {
  const missing = Object.assign(new Error("spawn ssh-keygen ENOENT"), { code: "ENOENT" });
  assert.equal(sshKeygenSkipReason(missing), "ssh-keygen is not installed");
  const present = Object.assign(new Error("usage"), { status: 1 });
  assert.equal(sshKeygenSkipReason(present), false);
  assert.equal(sshKeygenSkipReason(null), false);
});

test("parseDERKey reads an OpenSSH ed25519 host certificate the way KEX does", { skip: sshKeygenSkip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-hostcert-"));
  try {
    const minted = mintEd25519HostCert(dir);
    assert.equal(minted.type, HOST_CERT);
    assert.equal(minted.privateKey instanceof Error, false, minted.privateKey.message);
    const typeLen = minted.certBlob.readUInt32BE(0);
    const type = minted.certBlob.subarray(4, 4 + typeLen).toString();
    const keyMaterial = minted.certBlob.subarray(4 + typeLen);
    const parsed = parseDERKey(keyMaterial, type);
    assert.equal(parsed instanceof Error, false, parsed instanceof Error ? parsed.message : "");
    assert.equal(parsed.type, HOST_CERT);
    const message = Buffer.from("kex-exchange-hash");
    const signature = minted.privateKey.sign(message);
    assert.equal(signature instanceof Error, false, signature instanceof Error ? signature.message : "");
    assert.equal(parsed.verify(message, signature), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("host key signature type accepts the underlying algorithm for host certificates", () => {
  assert.equal(typeof hostKeySignatureTypeAccepted, "function");
  assert.equal(hostKeySignatureTypeAccepted(HOST_CERT, "ssh-ed25519"), true);
  assert.equal(hostKeySignatureTypeAccepted(HOST_CERT, HOST_CERT), true);
  assert.equal(hostKeySignatureTypeAccepted(HOST_CERT, "ssh-rsa"), false);
  assert.equal(
    hostKeySignatureTypeAccepted("ecdsa-sha2-nistp256-cert-v01@openssh.com", "ecdsa-sha2-nistp256"),
    true,
  );
  assert.equal(
    hostKeySignatureTypeAccepted("rsa-sha2-256-cert-v01@openssh.com", "rsa-sha2-256"),
    true,
  );
  assert.equal(
    hostKeySignatureTypeAccepted("rsa-sha2-256-cert-v01@openssh.com", "rsa-sha2-512"),
    false,
  );
  assert.equal(
    hostKeySignatureTypeAccepted("rsa-sha2-256-cert-v01@openssh.com", "ssh-rsa"),
    false,
  );
  assert.equal(
    hostKeySignatureTypeAccepted("rsa-sha2-256-cert-v00@openssh.com", "ssh-rsa"),
    false,
  );
  assert.equal(
    hostKeySignatureTypeAccepted("rsa-sha2-512-cert-v01@openssh.com", "rsa-sha2-512"),
    true,
  );
  assert.equal(
    hostKeySignatureTypeAccepted("rsa-sha2-512-cert-v01@openssh.com", "rsa-sha2-256"),
    false,
  );
  assert.equal(
    hostKeySignatureTypeAccepted("rsa-sha2-512-cert-v01@openssh.com", "ssh-rsa"),
    false,
  );
  assert.equal(
    hostKeySignatureTypeAccepted("ssh-rsa-cert-v01@openssh.com", "rsa-sha2-256"),
    true,
  );
  assert.equal(
    hostKeySignatureTypeAccepted("ssh-rsa-cert-v01@openssh.com", "rsa-sha2-512"),
    true,
  );
  assert.equal(
    hostKeySignatureTypeAccepted("ssh-rsa-cert-v01@openssh.com", "ssh-rsa"),
    true,
  );
  assert.equal(
    hostKeySignatureTypeAccepted("ssh-rsa-cert-v00@openssh.com", "ssh-rsa"),
    true,
  );
  assert.equal(
    hostKeyBlobTypeAccepted("rsa-sha2-256-cert-v01@openssh.com", "ssh-rsa-cert-v01@openssh.com"),
    true,
  );
  assert.equal(
    hostKeyBlobTypeAccepted("rsa-sha2-512-cert-v01@openssh.com", "ssh-rsa-cert-v01@openssh.com"),
    true,
  );
  assert.equal(
    hostKeyBlobTypeAccepted("rsa-sha2-256-cert-v01@openssh.com", "ssh-rsa"),
    false,
  );
  assert.equal(
    hostKeyBlobTypeAccepted("rsa-sha2-512-cert-v01@openssh.com", "ssh-rsa"),
    false,
  );
  assert.equal(hostKeyBlobTypeAccepted("rsa-sha2-256", "ssh-rsa"), true);
  assert.equal(hostKeyBlobTypeAccepted("rsa-sha2-512", "ssh-rsa"), true);
  assert.equal(hostKeySignatureTypeAccepted("ssh-ed25519", "ssh-ed25519"), true);
  assert.equal(hostKeySignatureTypeAccepted("ssh-ed25519", HOST_CERT), false);
  assert.equal(hostKeySignatureTypeAccepted("rsa-sha2-256", "ssh-rsa"), false);
  assert.equal(hostKeySignatureTypeAccepted("rsa-sha2-512", "rsa-sha2-256"), false);
});

function loadSsh2WithCertHostKey(pem, certBlob) {
  // ssh2.Server only accepts PEM text and then advertises privateKey.type.
  // Reload it after wrapping parseKey so this one key is presented as an
  // OpenSSH host certificate while signing still uses the embedded key.
  const keyParser = require("ssh2/lib/protocol/keyParser.js");
  const originalParseKey = keyParser.parseKey;
  keyParser.parseKey = function parseCertHostKey(data, passphrase) {
    const parsed = originalParseKey(data, passphrase);
    if (!(parsed instanceof Error) && data === pem) {
      parsed.type = HOST_CERT;
      parsed.getPublicSSH = () => certBlob;
    }
    return parsed;
  };
  const reloadIds = ["ssh2/lib/server.js", "ssh2/lib/index.js", "ssh2"];
  const resolved = reloadIds.map((id) => require.resolve(id));
  const previous = resolved.map((filename) => require.cache[filename]);
  for (const filename of resolved) delete require.cache[filename];
  const ssh2 = require("ssh2");
  for (let i = 0; i < resolved.length; i++) {
    if (previous[i]) require.cache[resolved[i]] = previous[i];
    else delete require.cache[resolved[i]];
  }
  keyParser.parseKey = originalParseKey;
  return ssh2;
}

test("ssh2 client completes KEX against a cert-only ed25519 host key", { skip: sshKeygenSkip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-hostcert-kex-"));
  const minted = mintEd25519HostCert(dir);
  assert.equal(minted.privateKey instanceof Error, false, minted.privateKey.message);
  const { Client, Server } = loadSsh2WithCertHostKey(minted.privateKeyPem, minted.certBlob);

  const server = new Server({ hostKeys: [minted.privateKeyPem] }, (client) => {
    client.on("error", () => {});
    client.on("authentication", (ctx) => ctx.reject());
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const authError = await new Promise((resolve, reject) => {
      const client = new Client();
      const timer = setTimeout(() => {
        client.end();
        reject(new Error("timed out waiting for KEX/auth"));
      }, 10000);
      client.on("ready", () => {
        clearTimeout(timer);
        client.end();
        reject(new Error("authentication unexpectedly succeeded"));
      });
      client.on("error", (err) => {
        clearTimeout(timer);
        client.end();
        resolve(err);
      });
      client.connect({
        host: "127.0.0.1",
        port: server.address().port,
        username: "netcatty",
        password: "not-the-password",
        readyTimeout: 8000,
      });
    });
    assert.match(authError.message, /authentication/i);
    assert.doesNotMatch(
      authError.message,
      /Handshake failed|no matching host key|Wrong signature type|Unsupported OpenSSH|signature verification failed|Host key does not match/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
