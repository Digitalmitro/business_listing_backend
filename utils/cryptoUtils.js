"use strict";

const crypto = require("node:crypto");

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 12 bytes recommended for GCM
const AUTH_TAG_LENGTH = 16; // 16 bytes auth tag

/**
 * Derives a 32-byte secret key from environment variables.
 * Uses SHA-256 hash of ENCRYPTION_KEY or JWT_SECRET to guarantee exact 32-byte length.
 * @returns {Buffer} 32-byte key buffer
 */
function getSecretKey() {
  const secret =
    process.env.ENCRYPTION_KEY ||
    process.env.JWT_SECRET ||
    "fallback_secret_key_urban_citations_2026_secure";
  return crypto.createHash("sha256").update(String(secret)).digest();
}

/**
 * Encrypts sensitive text (e.g. OAuth access or refresh tokens) using AES-256-GCM.
 * @param {string} text - Plaintext string to encrypt.
 * @returns {string|null} Encrypted string in format "ivHex:authTagHex:encryptedHex", or null if input is empty/null.
 */
function encrypt(text) {
  if (text === null || text === undefined || text === "") {
    return null;
  }
  if (typeof text !== "string") {
    text = String(text);
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const key = getSecretKey();
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");

  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

/**
 * Decrypts an AES-256-GCM encrypted string.
 * @param {string} encryptedText - Encrypted string in format "ivHex:authTagHex:encryptedHex".
 * @returns {string|null} Decrypted plaintext string, or null if input is null/empty.
 * @throws {Error} If payload format is invalid or decryption/auth tag verification fails.
 */
function decrypt(encryptedText) {
  if (encryptedText === null || encryptedText === undefined || encryptedText === "") {
    return null;
  }
  if (typeof encryptedText !== "string") {
    throw new TypeError("Encrypted input must be a string");
  }

  const parts = encryptedText.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted token format. Expected iv:authTag:ciphertext");
  }

  const [ivHex, authTagHex, ciphertextHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const key = getSecretKey();

  if (iv.length !== IV_LENGTH) {
    throw new Error(`Invalid IV length: expected ${IV_LENGTH} bytes`);
  }
  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error(`Invalid auth tag length: expected ${AUTH_TAG_LENGTH} bytes`);
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertextHex, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

module.exports = {
  encrypt,
  decrypt,
  getSecretKey,
};
