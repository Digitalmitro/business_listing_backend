"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const Business = require("../models/Business");
const { updateBusiness } = require("./businessController");
const { upload } = require("../config/multerConfig");

const stockPhoto = "https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?q=80&w=1000&auto=format&fit=crop";
const stockLogo = "https://img.icons8.com/fluency/100/000000/organization.png";

test("admin media survives multipart upload, edits, removal and a subsequent read", async (context) => {
  const uploadDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "uc-business-media-"));
  const previousDirectory = process.env.UPLOAD_DIR;
  process.env.UPLOAD_DIR = uploadDirectory;
  let stored = { _id: "business-1", businessLogo: stockLogo, photos: [stockPhoto] };
  context.mock.method(Business, "findById", async () => structuredClone(stored));
  context.mock.method(Business, "findByIdAndUpdate", async (id, updates, options) => {
    assert.equal(options.runValidators, true);
    stored = { ...stored, ...updates };
    return structuredClone(stored);
  });
  const app = express();
  app.put("/update", upload.fields([{ name: "businessLogo", maxCount: 1 }, { name: "photos", maxCount: 5 }]), updateBusiness);
  app.get("/business", async (req, res) => res.json(await Business.findById("business-1")));
  app.use("/uploads", express.static(uploadDirectory));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (previousDirectory === undefined) delete process.env.UPLOAD_DIR;
    else process.env.UPLOAD_DIR = previousDirectory;
    await fs.rm(uploadDirectory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64");
  async function update(data, files = {}) {
    const form = new FormData();
    form.append("businessData", JSON.stringify({ _id: "business-1", ...data }));
    for (const [field, name] of Object.entries(files)) form.append(field, new Blob([png], { type: "image/png" }), name);
    const response = await fetch(`${base}/update`, { method: "PUT", body: form });
    return { response, body: await response.json() };
  }

  const uploaded = await update({ photos: [stockPhoto] }, { businessLogo: "Digital Mitro.png", photos: "marketing Kolkata.png" });
  assert.equal(uploaded.response.status, 200);
  assert.equal(stored.photos.length, 1, "stock photo must not remain ahead of uploaded media");
  assert.match(stored.businessLogo, /-Digital Mitro\.png$/);
  assert.match(stored.photos[0], /-marketing Kolkata\.png$/);
  const readBack = await (await fetch(`${base}/business`)).json();
  for (const filename of [readBack.businessLogo, ...readBack.photos]) {
    const image = await fetch(`${base}/uploads/${encodeURIComponent(filename)}`);
    assert.equal(image.status, 200);
    assert.match(image.headers.get("content-type"), /image\/png/);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  }

  const uploadedLogo = stored.businessLogo;
  const external = "https://cdn.example.com/business%20photo.jpg?version=2";
  await update({ photos: [external] });
  assert.equal(stored.businessLogo, uploadedLogo, "an omitted logo must be preserved");
  assert.deepEqual(stored.photos, [external], "retained external URLs must survive exactly");
  await update({ businessName: "Updated name" });
  assert.deepEqual(stored.photos, [external], "omitted photos must be preserved");
  await update({ photos: [], businessLogo: null });
  assert.deepEqual(stored.photos, []);
  assert.equal(stored.businessLogo, "", "explicit logo removal must persist");
  assert.equal((await update({ photos: "invalid" })).response.status, 400);
  assert.deepEqual(stored.photos, [], "invalid updates must not overwrite saved media");

  const malformed = new FormData();
  malformed.append("businessData", "{");
  assert.equal((await fetch(`${base}/update`, { method: "PUT", body: malformed })).status, 400);
});

test("new listings have no unrelated stock imagery", () => {
  const business = new Business();
  assert.equal(business.businessLogo, "");
  assert.deepEqual([...business.photos], []);
});
