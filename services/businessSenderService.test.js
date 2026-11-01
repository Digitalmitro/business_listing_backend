"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

process.env.JWT_SECRET = process.env.JWT_SECRET || "unit-test-secret";
const sender = require("./businessSenderService");

test("SMTP passwords are encrypted (random IV, authenticated) and decrypt back", () => {
  const a = sender.encrypt("app-password-123");
  const b = sender.encrypt("app-password-123");
  assert.notEqual(a, b, "a fresh IV is used for every encryption");
  assert.ok(!a.includes("app-password"), "ciphertext does not contain the password");
  assert.equal(sender.decrypt(a), "app-password-123");
  const [iv, tag, data] = a.split(".");
  const tampered = [iv, tag, `${data.slice(0, -2)}AA`].join(".");
  assert.throws(() => sender.decrypt(tampered), /unreadable/);
});

test("a different key cannot read stored passwords", () => {
  const blob = sender.encrypt("secret");
  const previous = process.env.SENDER_CREDENTIALS_KEY;
  process.env.SENDER_CREDENTIALS_KEY = "a-completely-different-key";
  try {
    assert.throws(() => sender.decrypt(blob), /unreadable/);
  } finally {
    if (previous === undefined) delete process.env.SENDER_CREDENTIALS_KEY;
    else process.env.SENDER_CREDENTIALS_KEY = previous;
  }
});

test("settings are validated and normalized", () => {
  const ok = sender.normalizeSettings({ email: " Owner@Example.COM ", smtpHost: "SMTP.Gmail.com", smtpPort: "465", smtpPass: "x" });
  assert.equal(ok.email, "owner@example.com");
  assert.equal(ok.smtpHost, "smtp.gmail.com");
  assert.equal(ok.smtpPort, 465);
  assert.equal(ok.secure, true, "port 465 defaults to implicit TLS");
  assert.equal(ok.smtpUser, "owner@example.com", "user defaults to the address");
  assert.equal(sender.normalizeSettings({ email: "a@b.co", smtpHost: "smtp.b.co", smtpPort: 587 }).secure, false);
  assert.throws(() => sender.normalizeSettings({ email: "nope", smtpHost: "smtp.b.co", smtpPort: 587 }), /valid email/);
  assert.throws(() => sender.normalizeSettings({ email: "a@b.co", smtpHost: "smtp.b.co", smtpPort: 8080 }), /port/);
  assert.throws(() => sender.normalizeSettings({ email: "a@b.co", smtpHost: "", smtpPort: 587 }), /host/);
});

test("private and loopback addresses are recognised (blocked as SMTP hosts in production)", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.1.5", "172.16.0.9", "169.254.1.1", "::1", "fd00::1"]) assert.equal(sender.isPrivateAddress(ip), true, ip);
  for (const ip of ["8.8.8.8", "142.250.4.108", "2607:f8b0::1"]) assert.equal(sender.isPrivateAddress(ip), false, ip);
});

test("the owner view never exposes the password or token", () => {
  const view = sender.toView({ email: "a@b.co", smtpHost: "h", smtpPort: 587, smtpUser: "u", smtpPassEnc: "xyz", verificationTokenHash: "abc", status: "verified" });
  assert.equal(view.connected, true);
  assert.equal("smtpPassEnc" in view, false);
  assert.equal("smtpPass" in view, false);
  assert.equal("verificationTokenHash" in view, false);
  assert.deepEqual(sender.toView(null), { connected: false, status: "not_connected" });
});

test("SMTP errors are turned into owner-friendly messages", () => {
  assert.match(sender.friendlySmtpError(new Error("535-5.7.8 Username and Password not accepted")), /App Password/);
  assert.match(sender.friendlySmtpError(new Error("getaddrinfo ENOTFOUND smtp.nope")), /could not be found/);
  assert.match(sender.friendlySmtpError(new Error("connect ECONNREFUSED")), /Could not connect/);
});
