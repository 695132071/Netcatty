"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash, generateKeyPairSync, sign } = require("node:crypto");
const {
  parseKey,
  getOpenSSHCertSignatureAlgorithm,
} = require("ssh2/lib/protocol/keyParser.js");
const { convertSignature } = require("ssh2/lib/protocol/utils.js");

function buildSkEd25519PublicLine() {
  const type = Buffer.from("sk-ssh-ed25519@openssh.com");
  const pub = Buffer.alloc(32, 9);
  const app = Buffer.from("ssh:");
  const parts = [type, pub, app];
  let len = 0;
  for (const part of parts) len += 4 + part.length;
  const buf = Buffer.alloc(len);
  let offset = 0;
  for (const part of parts) {
    buf.writeUInt32BE(part.length, offset);
    offset += 4;
    part.copy(buf, offset);
    offset += part.length;
  }
  return `sk-ssh-ed25519@openssh.com ${buf.toString("base64")} netcatty@sk`;
}

function buildSkEcdsaPublicLine() {
  // Uncompressed P-256 point: 0x04 || X(32) || Y(32)
  const point = Buffer.alloc(65, 0);
  point[0] = 0x04;
  point[64] = 1;
  const type = Buffer.from("sk-ecdsa-sha2-nistp256@openssh.com");
  const curve = Buffer.from("nistp256");
  const app = Buffer.from("ssh:");
  const parts = [type, curve, point, app];
  let len = 0;
  for (const part of parts) len += 4 + part.length;
  const buf = Buffer.alloc(len);
  let offset = 0;
  for (const part of parts) {
    buf.writeUInt32BE(part.length, offset);
    offset += 4;
    part.copy(buf, offset);
    offset += part.length;
  }
  return `sk-ecdsa-sha2-nistp256@openssh.com ${buf.toString("base64")} netcatty@sk`;
}

test("ssh2 parseKey accepts sk-ssh-ed25519 public keys", () => {
  const key = parseKey(buildSkEd25519PublicLine());
  assert.equal(key instanceof Error, false, key instanceof Error ? key.message : "");
  assert.equal(key.type, "sk-ssh-ed25519@openssh.com");
  assert.equal(typeof key.getPublicSSH, "function");
  assert.equal(key.getApplication?.(), "ssh:");
  const signErr = key.sign(Buffer.from("challenge"));
  assert.equal(signErr instanceof Error, true);
  assert.match(String(signErr.message), /security-key|ssh-agent|FIDO/i);
});

test("ssh2 parseKey accepts sk-ecdsa-sha2-nistp256 public keys", () => {
  const key = parseKey(buildSkEcdsaPublicLine());
  assert.equal(key instanceof Error, false, key instanceof Error ? key.message : "");
  assert.equal(key.type, "sk-ecdsa-sha2-nistp256@openssh.com");
  assert.equal(key.getApplication?.(), "ssh:");
});

function buildSkEd25519CertPublicLine() {
  // Minimal OpenSSH SK cert wire shape: type, nonce, then SK public fields.
  const type = Buffer.from("sk-ssh-ed25519-cert-v01@openssh.com");
  const nonce = Buffer.alloc(16, 7);
  const pub = Buffer.alloc(32, 9);
  const app = Buffer.from("ssh:");
  const parts = [type, nonce, pub, app];
  let len = 0;
  for (const part of parts) len += 4 + part.length;
  const buf = Buffer.alloc(len);
  let offset = 0;
  for (const part of parts) {
    buf.writeUInt32BE(part.length, offset);
    offset += 4;
    part.copy(buf, offset);
    offset += part.length;
  }
  return `sk-ssh-ed25519-cert-v01@openssh.com ${buf.toString("base64")} netcatty@sk-cert`;
}

test("ssh2 parseKey accepts OpenSSH-order SK certificate public keys", () => {
  const line = buildSkEd25519CertPublicLine();
  const certBlob = Buffer.from(line.split(/\s+/)[1], "base64");
  const key = parseKey(line);
  assert.equal(key instanceof Error, false, key instanceof Error ? key.message : "");
  assert.equal(key.type, "sk-ssh-ed25519-cert-v01@openssh.com");
  assert.equal(key.getApplication?.(), "ssh:");
  assert.deepEqual(key.getPublicSSH(), certBlob);
});

test("ssh2 maps SK certificate identities to full wire signature algorithms", () => {
  assert.equal(
    getOpenSSHCertSignatureAlgorithm("sk-ssh-ed25519-cert-v01@openssh.com"),
    "sk-ssh-ed25519@openssh.com",
  );
  assert.equal(
    getOpenSSHCertSignatureAlgorithm("sk-ecdsa-sha2-nistp256-cert-v01@openssh.com"),
    "sk-ecdsa-sha2-nistp256@openssh.com",
  );
  assert.equal(
    getOpenSSHCertSignatureAlgorithm("rsa-sha2-256-cert-v01@openssh.com"),
    "rsa-sha2-256",
  );
  assert.equal(
    getOpenSSHCertSignatureAlgorithm("ecdsa-sha2-nistp256-cert-v01@openssh.com"),
    "ecdsa-sha2-nistp256",
  );
  assert.equal(
    getOpenSSHCertSignatureAlgorithm("sk-ssh-ed25519@openssh.com"),
    "sk-ssh-ed25519@openssh.com",
  );
});

test("ssh2 agent protocol preserves SK signature framing, flags and counter", async () => {
  const { AgentProtocol } = require("ssh2/lib/agent.js");
  for (const line of [buildSkEd25519PublicLine(), buildSkEcdsaPublicLine(), buildSkEd25519CertPublicLine()]) {
    const client = new AgentProtocol(true);
    const server = new AgentProtocol(false);
    client.pipe(server).pipe(client);
    const raw = Buffer.alloc(64, 7);
    const payload = Buffer.alloc(4 + raw.length + 5);
    payload.writeUInt32BE(raw.length, 0);
    raw.copy(payload, 4);
    payload[4 + raw.length] = 5; // presence and verification
    payload.writeUInt32BE(0x12345678, 5 + raw.length);
    server.on("sign", (request, key) => {
      assert.equal(request.getContext(), getOpenSSHCertSignatureAlgorithm(key.type));
      server.signReply(request, payload);
    });
    try {
      const returned = await new Promise((resolve, reject) => client.sign(
        parseKey(line), Buffer.from("challenge"), {},
        (error, signature) => error ? reject(error) : resolve(signature),
      ));
      assert.deepEqual(returned, payload);
    } finally {
      client.destroy();
      server.destroy();
    }
  }
});

function sshString(value) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const out = Buffer.alloc(4 + body.length);
  out.writeUInt32BE(body.length, 0);
  body.copy(out, 4);
  return out;
}

function opensshPublicLine(typeName, fields) {
  const blob = Buffer.concat([
    sshString(typeName),
    ...fields.map((field) => sshString(field)),
  ]);
  return `${typeName} ${blob.toString("base64")} netcatty@sk`;
}

function skEcdsaSignature(rawSig, flags, counter) {
  const out = Buffer.alloc(4 + rawSig.length + 5);
  out.writeUInt32BE(rawSig.length, 0);
  rawSig.copy(out, 4);
  const pos = 4 + rawSig.length;
  out[pos] = flags;
  out.writeUInt32BE(counter, pos + 1);
  return out;
}

test("ssh2 verifies an SK ECDSA certificate with the same P-256 signature as the plain key", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const jwk = publicKey.export({ format: "jwk" });
  const point = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from(jwk.y, "base64url"),
  ]);
  const application = "ssh:";
  const plain = parseKey(opensshPublicLine("sk-ecdsa-sha2-nistp256@openssh.com", [
    "nistp256",
    point,
    application,
  ]));
  const cert = parseKey(opensshPublicLine("sk-ecdsa-sha2-nistp256-cert-v01@openssh.com", [
    Buffer.alloc(16, 3),
    "nistp256",
    point,
    application,
  ]));
  assert.equal(plain instanceof Error, false, plain instanceof Error ? plain.message : "");
  assert.equal(cert instanceof Error, false, cert instanceof Error ? cert.message : "");
  assert.equal(cert.type, "sk-ecdsa-sha2-nistp256-cert-v01@openssh.com");
  assert.equal(cert.getApplication(), application);

  const message = Buffer.from("kex-exchange-hash");
  const flags = 0x01;
  const counter = 0x12345678;
  const appHash = createHash("sha256").update(application).digest();
  const dataHash = createHash("sha256").update(message).digest();
  const signedData = Buffer.alloc(appHash.length + 1 + 4 + dataHash.length);
  let offset = 0;
  appHash.copy(signedData, offset);
  offset += appHash.length;
  signedData[offset++] = flags;
  signedData.writeUInt32BE(counter, offset);
  offset += 4;
  dataHash.copy(signedData, offset);

  const der = sign("sha256", signedData, privateKey);
  const rawSig = convertSignature(der, "ecdsa-sha2-nistp256");
  assert.ok(Buffer.isBuffer(rawSig));
  const signature = skEcdsaSignature(rawSig, flags, counter);

  const plainResult = plain.verify(message, signature);
  assert.equal(
    plainResult,
    true,
    plainResult instanceof Error ? plainResult.message : String(plainResult),
  );
  const certResult = cert.verify(message, signature);
  assert.equal(
    certResult,
    true,
    certResult instanceof Error ? certResult.message : String(certResult),
  );
});
