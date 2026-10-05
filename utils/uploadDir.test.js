"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { uploadDir, resolveStoredUploadPath } = require("./uploadDir");

const BACKEND_ROOT = path.join(__dirname, "..");

function withUploadDir(value, fn) {
  const previous = process.env.UPLOAD_DIR;
  if (value === undefined) delete process.env.UPLOAD_DIR;
  else process.env.UPLOAD_DIR = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.UPLOAD_DIR;
    else process.env.UPLOAD_DIR = previous;
  }
}

test("defaults to public/uploads inside the backend", () => {
  withUploadDir(undefined, () => {
    assert.equal(uploadDir(), path.join(BACKEND_ROOT, "public/uploads"));
    assert.equal(uploadDir("attachments"), path.join(BACKEND_ROOT, "public/uploads/attachments"));
  });
});

test("uses UPLOAD_DIR when set", () => {
  withUploadDir("/srv/urbancitations/uploads", () => {
    assert.equal(uploadDir(), "/srv/urbancitations/uploads");
    assert.equal(uploadDir("imports"), "/srv/urbancitations/uploads/imports");
  });
});

test("maps legacy relative attachment paths into UPLOAD_DIR", () => {
  withUploadDir("/srv/urbancitations/uploads", () => {
    assert.equal(
      resolveStoredUploadPath("public/uploads/attachments/1-a.pdf"),
      "/srv/urbancitations/uploads/attachments/1-a.pdf",
    );
    assert.equal(resolveStoredUploadPath("/srv/urbancitations/uploads/attachments/2-b.pdf"), "/srv/urbancitations/uploads/attachments/2-b.pdf");
  });
});
