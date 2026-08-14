"use strict";

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "test-only-encryption-key-32-characters-minimum";

const test = require("node:test");
const assert = require("node:assert/strict");
const { encrypt, decrypt, getSecretKey } = require("./cryptoUtils");

test("encrypt and decrypt perform exact round-trip for strings", () => {
  const sampleToken = "ya29.a0AfB_qD6ExampleAccessTokenSecret123456789";
  const encrypted = encrypt(sampleToken);

  assert.notEqual(encrypted, sampleToken);
  assert.equal(typeof encrypted, "string");
  assert.equal(encrypted.split(":").length, 3);

  const decrypted = decrypt(encrypted);
  assert.equal(decrypted, sampleToken);
});

test("encrypt and decrypt handle null and empty strings without throwing", () => {
  assert.equal(encrypt(null), null);
  assert.equal(encrypt(""), null);
  assert.equal(decrypt(null), null);
  assert.equal(decrypt(""), null);
});

test("encrypt produces unique ciphertexts due to random IV", () => {
  const token = "my-secret-token";
  const encrypted1 = encrypt(token);
  const encrypted2 = encrypt(token);

  assert.notEqual(encrypted1, encrypted2);
  assert.equal(decrypt(encrypted1), token);
  assert.equal(decrypt(encrypted2), token);
});

test("decrypt throws error when ciphertext or authTag is tampered", () => {
  const encrypted = encrypt("sensitive-data");
  const parts = encrypted.split(":");
  
  // Tamper with the ciphertext component
  parts[2] = parts[2].slice(0, -2) + "00";
  const tampered = parts.join(":");

  assert.throws(() => {
    decrypt(tampered);
  }, /Unsupported state or unable to authenticate data|bad decrypt/i);
});

test("decrypt throws error on malformed format", () => {
  assert.throws(() => {
    decrypt("not-valid-colon-delimited-payload");
  }, /Invalid encrypted token format/i);
});
