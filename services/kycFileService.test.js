"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
const kyc = require("./kycFileService");

function withDirs(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uc-kyc-"));
  const prev = { UPLOAD_DIR: process.env.UPLOAD_DIR, PRIVATE_UPLOAD_DIR: process.env.PRIVATE_UPLOAD_DIR, BACKEND_URL: process.env.BACKEND_URL };
  process.env.UPLOAD_DIR = path.join(root, "uploads");
  process.env.PRIVATE_UPLOAD_DIR = path.join(root, "private");
  process.env.BACKEND_URL = "https://api.test";
  fs.mkdirSync(process.env.UPLOAD_DIR, { recursive: true });
  context.after(() => {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test("private dir lives outside the public upload dir", (context) => {
  withDirs(context);
  const dir = kyc.ensurePrivateKycDir();
  assert.ok(!dir.startsWith(path.resolve(process.env.UPLOAD_DIR)));
  assert.ok(fs.existsSync(dir));
});

test("signed links verify, expire and resist tampering", (context) => {
  withDirs(context);
  const url = new URL(kyc.signedKycUrl("1700000000000123456-pan card.png"));
  assert.equal(url.origin, "https://api.test");
  const filename = decodeURIComponent(url.pathname.split("/").pop());
  assert.equal(filename, "1700000000000123456-pan card.png");
  const exp = url.searchParams.get("exp");
  const sig = url.searchParams.get("sig");
  assert.equal(kyc.verifySignature(filename, exp, sig), true);
  assert.equal(kyc.verifySignature("other.png", exp, sig), false);
  assert.equal(kyc.verifySignature(filename, String(Number(exp) + 1), sig), false);
  assert.equal(kyc.verifySignature(filename, String(Math.floor(Date.now() / 1000) - 10), sig), false);
  assert.equal(kyc.verifySignature(filename, exp, "deadbeef"), false);
});

test("files resolve from the private dir first, then legacy public uploads; no traversal", (context) => {
  withDirs(context);
  const priv = kyc.ensurePrivateKycDir();
  fs.writeFileSync(path.join(priv, "new.pdf"), "new");
  fs.writeFileSync(path.join(process.env.UPLOAD_DIR, "legacy.png"), "old");
  assert.equal(kyc.resolveKycFile("new.pdf"), path.join(priv, "new.pdf"));
  assert.equal(kyc.resolveKycFile("legacy.png"), path.join(process.env.UPLOAD_DIR, "legacy.png"));
  assert.equal(kyc.resolveKycFile("../../etc/passwd"), null);
  assert.equal(kyc.resolveKycFile("missing.png"), null);
  assert.equal(kyc.safeFilename(".env"), null);
});

test("presentKyc hides documents from the public and adds links for owner/admin", (context) => {
  withDirs(context);
  const stored = { country: "India", status: "pending", documents: new Map([["PAN Card", "1-pan.png"]]) };
  const pub = kyc.presentKyc(stored, null, { canSeeDocuments: false });
  assert.equal(pub.documents, undefined);
  assert.equal(pub.status, "pending");
  const own = kyc.presentKyc(stored, null, { canSeeDocuments: true });
  assert.deepEqual(own.documents, { "PAN Card": "1-pan.png" });
  assert.match(own.documentUrls["PAN Card"], /\/api\/business\/kyc-file\/1-pan\.png\?exp=\d+&sig=[0-9a-f]{64}$/);
});
