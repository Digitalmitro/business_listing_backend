"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const { detectKind, hasScriptExtension } = require("./uploadValidation");

// multerConfig writes to UPLOAD_DIR; point it at a temporary directory.
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "upload-validation-"));
const uploadDir = path.join(workDir, "uploads");
// attachments/ is deliberately not created: the uploader must create it.
fs.mkdirSync(uploadDir, { recursive: true });
process.env.UPLOAD_DIR = uploadDir;
const { upload, attachmentUpload } = require("../config/multerConfig");

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(16)]);
const PHP = Buffer.from("<?php echo 'test'; ?>");

let server;
let baseUrl;

test.before(async () => {
  const app = express();
  const ok = (req, res) => res.json({ files: [req.file, ...(Array.isArray(req.files) ? req.files : Object.values(req.files || {}).flat())].filter(Boolean).map((f) => f.filename) });
  app.post("/single", upload.single("image"), ok);
  app.post("/fields", upload.fields([{ name: "businessLogo", maxCount: 1 }, { name: "photos", maxCount: 5 }]), ok);
  app.post("/kyc", upload.array("kycDocuments", 10), ok);
  app.post("/csv", upload.single("csvFile"), ok);
  app.post("/video", upload.single("video"), ok);
  app.post("/attachments", attachmentUpload.array("attachments", 5), ok);
  app.use((err, req, res, _next) => res.status(err.status || 500).json({ success: false, message: err.message }));
  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  fs.rmSync(workDir, { recursive: true, force: true });
});

function storedNames() {
  return fs.readdirSync(uploadDir).filter((name) => name !== "attachments");
}

async function post(route, parts) {
  const form = new FormData();
  for (const { field, name, type, data } of parts) form.append(field, new Blob([data], { type }), name);
  const res = await fetch(baseUrl + route, { method: "POST", body: form });
  return { status: res.status, body: await res.json() };
}

test("detectKind recognises allowed signatures and rejects unknown content", () => {
  assert.equal(detectKind(PNG), "png");
  assert.equal(detectKind(JPEG), "jpeg");
  assert.equal(detectKind(Buffer.from("GIF89a....")), "gif");
  assert.equal(detectKind(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "webp");
  assert.equal(detectKind(Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from("ftypavif")])), "avif");
  assert.equal(detectKind(MP4), "isoVideo");
  assert.equal(detectKind(PDF), "pdf");
  assert.equal(detectKind(Buffer.from("PK\u0003\u0004rest")), "zip");
  assert.equal(detectKind(Buffer.from("name,city\nA,B\n")), "text");
  assert.equal(detectKind(Buffer.from([0x00, 0x01, 0x02, 0x03])), "unknown");
});

test("hasScriptExtension catches script and double extensions but not dotted legitimate names", () => {
  assert.equal(hasScriptExtension("1789648882429-lol.php"), true);
  assert.equal(hasScriptExtension("/shell.PHP.jpg"), true);
  assert.equal(hasScriptExtension("page.html"), true);
  assert.equal(hasScriptExtension("icon.svg"), true);
  assert.equal(hasScriptExtension("1773727385608-Washington, D.C..jpg"), false);
  assert.equal(hasScriptExtension("1768305187696-PET SERVICES.png"), false);
});

test("accepts a genuine PNG image", async () => {
  const res = await post("/single", [{ field: "image", name: "icon.png", type: "image/png", data: PNG }]);
  assert.equal(res.status, 200);
  assert.ok(storedNames().includes(res.body.files[0]));
});

test("rejects a .php file before it is written to disk", async () => {
  const before = storedNames().length;
  const res = await post("/single", [{ field: "image", name: "lol.php", type: "image/jpeg", data: PHP }]);
  assert.equal(res.status, 400);
  assert.equal(storedNames().length, before);
});

test("rejects PHP content renamed to .jpg and deletes the stored file", async () => {
  const before = storedNames().length;
  const res = await post("/single", [{ field: "image", name: "lol.jpg", type: "image/jpeg", data: PHP }]);
  assert.equal(res.status, 400);
  assert.match(res.body.message, /not one of/);
  assert.equal(storedNames().length, before);
});

test("rejects a JPEG/PHP polyglot", async () => {
  const before = storedNames().length;
  const res = await post("/single", [{ field: "image", name: "photo.jpg", type: "image/jpeg", data: Buffer.concat([JPEG, PHP]) }]);
  assert.equal(res.status, 400);
  assert.match(res.body.message, /embedded script/);
  assert.equal(storedNames().length, before);
});

test("rejects an image whose MIME type is not an image", async () => {
  const res = await post("/single", [{ field: "image", name: "icon.png", type: "text/html", data: PNG }]);
  assert.equal(res.status, 400);
});

test("one bad file removes every file from the same request", async () => {
  const before = storedNames().length;
  const res = await post("/fields", [
    { field: "businessLogo", name: "logo.png", type: "image/png", data: PNG },
    { field: "photos", name: "photo.jpg", type: "image/jpeg", data: PHP },
  ]);
  assert.equal(res.status, 400);
  assert.equal(storedNames().length, before);
});

test("non-image fields keep their legitimate formats", async () => {
  assert.equal((await post("/kyc", [{ field: "kycDocuments", name: "id.pdf", type: "application/pdf", data: PDF }])).status, 200);
  assert.equal((await post("/kyc", [{ field: "kycDocuments", name: "id.jpg", type: "image/jpeg", data: JPEG }])).status, 200);
  assert.equal((await post("/csv", [{ field: "csvFile", name: "cats.csv", type: "text/csv", data: Buffer.from("name\nPlumber\n") }])).status, 200);
  assert.equal((await post("/video", [{ field: "video", name: "intro.mp4", type: "video/mp4", data: MP4 }])).status, 200);
});

test("non-image fields still reject scripts", async () => {
  assert.equal((await post("/csv", [{ field: "csvFile", name: "cats.csv", type: "text/csv", data: PHP }])).status, 400);
  assert.equal((await post("/kyc", [{ field: "kycDocuments", name: "id.pdf", type: "application/pdf", data: PHP }])).status, 400);
  assert.equal((await post("/video", [{ field: "video", name: "intro.mp4", type: "video/mp4", data: PHP }])).status, 400);
});

test("email attachments reject script and web files", async () => {
  assert.equal((await post("/attachments", [{ field: "attachments", name: "invoice.html", type: "text/html", data: Buffer.from("<html></html>") }])).status, 400);
  assert.equal((await post("/attachments", [{ field: "attachments", name: "invoice.pdf", type: "application/pdf", data: PDF }])).status, 200);
});
