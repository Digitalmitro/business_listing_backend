"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

process.env.CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || "test-cloud";
process.env.CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || "key";
process.env.CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || "secret";
process.env.CLOUDINARY_ROOT_FOLDER = "unit-test-root";

const images = require("./imageStorageService");
const { validateImageBuffer } = require("../utils/uploadValidation");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);
const PHP_AS_PNG = Buffer.concat([PNG, Buffer.from("<?php system($_GET['c']); ?>")]);

function cloudinaryResult(publicId, extra = {}) {
  return {
    public_id: publicId,
    secure_url: `https://res.cloudinary.com/test-cloud/image/upload/v1/${publicId}.png`,
    resource_type: "image", format: "png", width: 1, height: 1, bytes: 68, version: 1,
    ...extra,
  };
}

// Fake mongoose-like model: countDocuments over an in-memory list, findById().select().lean().
function fakeModel(name, docs) {
  return {
    modelName: name,
    docs,
    async countDocuments(query) {
      const key = Object.keys(query).find((k) => k.endsWith(".publicId"));
      const [field] = key.split(".");
      return docs.filter((d) => d[field] && d[field].publicId === query[key] && !(query._id && String(d._id) === String(query._id.$ne))).length;
    },
    findById(id) {
      const doc = docs.find((d) => String(d._id) === String(id)) || null;
      return { select() { return this; }, async lean() { return doc; } };
    },
    schema: { path: (p) => (p === "iconUrl" ? { options: { default: "https://img.icons8.com/fluency/512/business.png" } } : null) },
  };
}

test("validateImageBuffer accepts real images and rejects scripts, polyglots and wrong signatures", () => {
  assert.equal(validateImageBuffer(PNG, { filename: "icon.png", mimetype: "image/png" }), null);
  assert.equal(validateImageBuffer(JPEG, { filename: "photo.jpg", mimetype: "image/jpeg" }), null);
  assert.match(validateImageBuffer(PNG, { filename: "shell.php", mimetype: "image/png" }), /Only JPG, PNG/);
  assert.match(validateImageBuffer(PNG, { filename: "shell.php.png", mimetype: "image/png" }), /Only JPG, PNG/);
  assert.match(validateImageBuffer(PNG, { filename: "icon.png", mimetype: "text/html" }), /Only JPG, PNG/);
  assert.match(validateImageBuffer(Buffer.from("<html><script>alert(1)</script></html>"), { filename: "icon.png", mimetype: "image/png" }), /not one of/);
  assert.match(validateImageBuffer(PHP_AS_PNG, { filename: "icon.png", mimetype: "image/png" }), /embedded script/);
  assert.match(validateImageBuffer(Buffer.alloc(0), { filename: "icon.png" }), /empty/);
});

test("uploadImage validates first, derives a content-addressed public_id and never hits Cloudinary for bad input", async (context) => {
  let calls = 0;
  context.mock.method(images.cloudinaryClient, "uploadBuffer", async () => { calls++; return cloudinaryResult("x"); });
  await assert.rejects(images.uploadImage(PHP_AS_PNG, { kind: "subcategory", filename: "a.png", mimetype: "image/png" }), (e) => e.status === 400 && /embedded script/.test(e.message));
  await assert.rejects(images.uploadImage(Buffer.alloc(0), { kind: "subcategory" }), (e) => e.status === 400);
  assert.equal(calls, 0);

  const hash = images.sha256(PNG);
  const expectedId = `unit-test-root/subcategories/${hash}`;
  context.mock.method(images.cloudinaryClient, "uploadBuffer", async (buffer, options) => {
    assert.equal(options.public_id, expectedId);
    assert.equal(options.overwrite, false);
    assert.equal(options.resource_type, "image");
    return cloudinaryResult(options.public_id);
  });
  const { asset, existing } = await images.uploadImage(PNG, { kind: "subcategory", filename: "a.png", mimetype: "image/png", legacyUrl: "https://server/uploads/a.png" });
  assert.equal(existing, false);
  assert.equal(asset.provider, "cloudinary");
  assert.equal(asset.publicId, expectedId);
  assert.equal(asset.sha256, hash);
  assert.equal(asset.legacyUrl, "https://server/uploads/a.png");
  assert.match(asset.url, /^https:\/\/res\.cloudinary\.com\//);
  assert.equal(asset.width, 1);
});

test("uploadImage reports an existing asset instead of duplicating it, and wraps Cloudinary failures as 502", async (context) => {
  context.mock.method(images.cloudinaryClient, "uploadBuffer", async (_b, o) => cloudinaryResult(o.public_id, { existing: true }));
  const { existing } = await images.uploadImage(PNG, { kind: "category", filename: "a.png", mimetype: "image/png" });
  assert.equal(existing, true);

  context.mock.method(images.cloudinaryClient, "uploadBuffer", async () => { throw new Error("Invalid Signature"); });
  await assert.rejects(images.uploadImage(PNG, { kind: "category", filename: "a.png", mimetype: "image/png" }), (e) => e.name === "ImageStorageError" && e.status === 502 && /Invalid Signature/.test(e.message));
});

test("releaseImage deletes only unreferenced assets and never throws", async (context) => {
  const shared = { provider: "cloudinary", publicId: "unit-test-root/subcategories/shared" };
  const lonely = { provider: "cloudinary", publicId: "unit-test-root/subcategories/lonely" };
  const model = fakeModel("Fake", [{ _id: "1", icon: shared }, { _id: "2", icon: shared }]);
  images.registerImageField(model, "icon");

  const destroyed = [];
  context.mock.method(images.cloudinaryClient, "destroy", async (id) => { destroyed.push(id); return { result: "ok" }; });

  assert.deepEqual((await images.releaseImage(shared)).status, "kept");
  assert.equal((await images.releaseImage(lonely)).status, "deleted");
  assert.deepEqual(destroyed, [lonely.publicId]);
  assert.equal((await images.releaseImage({ provider: "other", publicId: "x" })).status, "skipped");
  assert.equal((await images.releaseImage(null)).status, "skipped");

  // exclude: the record being replaced does not count as a reference
  const one = { provider: "cloudinary", publicId: "unit-test-root/subcategories/one" };
  model.docs.push({ _id: "3", icon: one });
  assert.equal((await images.releaseImage(one, { exclude: { modelName: "Fake", id: "3" } })).status, "deleted");

  context.mock.method(images.cloudinaryClient, "destroy", async () => { throw new Error("network down"); });
  const failed = await images.releaseImage(lonely);
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /network down/);

  context.mock.method(images.cloudinaryClient, "destroy", async () => ({ result: "not found" }));
  assert.equal((await images.releaseImage(lonely)).result, "not found");
});

test("stage/finish: new asset first, old asset released only after the saved record is verified", async (context) => {
  const model = fakeModel("Doc", []);
  images.registerImageField(model, "icon");
  const oldAsset = { provider: "cloudinary", publicId: "unit-test-root/subcategories/old", url: "https://res.cloudinary.com/old.png" };
  const doc = { _id: "d1", constructor: model, isNew: false, iconUrl: oldAsset.url, icon: oldAsset };
  model.docs.push(doc);

  const uploaded = [];
  const destroyed = [];
  context.mock.method(images.cloudinaryClient, "uploadBuffer", async (_b, o) => { uploaded.push(o.public_id); return cloudinaryResult(o.public_id); });
  context.mock.method(images.cloudinaryClient, "destroy", async (id) => { destroyed.push(id); return { result: "ok" }; });

  const staged = await images.stageImageUpload(doc, { buffer: PNG, originalname: "new.png", mimetype: "image/png" }, { kind: "subcategory" });
  assert.equal(uploaded.length, 1);
  assert.equal(staged.previous.publicId, oldAsset.publicId);
  assert.equal(doc.icon.publicId, staged.asset.publicId);
  assert.equal(doc.iconUrl, staged.asset.url);
  assert.equal(staged.asset.legacyUrl, undefined, "a Cloudinary URL is not recorded as legacy");
  assert.deepEqual(destroyed, [], "old asset must survive until the save is verified");

  // Simulate: the save did NOT persist (stored copy still has the old asset) -> old asset kept.
  model.docs[0] = { ...doc, icon: oldAsset };
  let result = await images.finishImageChange(doc, staged);
  assert.equal(result.verified, false);
  assert.deepEqual(destroyed, []);

  // Simulate the save persisted -> verified, old asset released.
  model.docs[0] = doc;
  result = await images.finishImageChange(doc, staged);
  assert.equal(result.verified, true);
  assert.equal(result.release.status, "deleted");
  assert.deepEqual(destroyed, [oldAsset.publicId]);

  // Replacing with identical bytes: same public_id -> nothing to release.
  const again = await images.stageImageUpload(doc, { buffer: PNG, originalname: "new.png", mimetype: "image/png" }, { kind: "subcategory" });
  const same = await images.finishImageChange(doc, again);
  assert.equal(same.release.status, "skipped");
});

test("legacy /uploads URL is recorded on first Cloudinary upload; placeholder and new records are not", async (context) => {
  const model = fakeModel("Doc2", []);
  context.mock.method(images.cloudinaryClient, "uploadBuffer", async (_b, o) => cloudinaryResult(o.public_id));
  const legacyDoc = { _id: "l1", constructor: model, isNew: false, iconUrl: "https://server.urbancitations.com/uploads/1-a.png" };
  const s1 = await images.stageImageUpload(legacyDoc, { buffer: PNG, originalname: "a.png", mimetype: "image/png" }, { kind: "category" });
  assert.equal(s1.asset.legacyUrl, "https://server.urbancitations.com/uploads/1-a.png");
  const placeholderDoc = { _id: "p1", constructor: model, isNew: false, iconUrl: "https://img.icons8.com/fluency/512/business.png" };
  const s2 = await images.stageImageUpload(placeholderDoc, { buffer: PNG, originalname: "a.png", mimetype: "image/png" }, { kind: "category" });
  assert.equal(s2.asset.legacyUrl, undefined);
  const newDoc = { _id: "n1", constructor: model, isNew: true, iconUrl: "https://img.icons8.com/fluency/512/business.png" };
  const s3 = await images.stageImageUpload(newDoc, { buffer: PNG, originalname: "a.png", mimetype: "image/png" }, { kind: "category" });
  assert.equal(s3.asset.legacyUrl, undefined);
});

test("stageImageRemoval resets to the schema default and discardStagedUpload cleans an orphaned upload", async (context) => {
  const model = fakeModel("Doc3", []);
  images.registerImageField(model, "icon");
  const asset = { provider: "cloudinary", publicId: "unit-test-root/categories/gone", url: "https://res.cloudinary.com/gone.png" };
  const doc = { _id: "r1", constructor: model, isNew: false, iconUrl: asset.url, icon: asset };
  const staged = images.stageImageRemoval(doc);
  assert.equal(doc.icon, undefined);
  assert.equal(doc.iconUrl, "https://img.icons8.com/fluency/512/business.png");
  assert.equal(staged.previous.publicId, asset.publicId);

  const destroyed = [];
  context.mock.method(images.cloudinaryClient, "destroy", async (id) => { destroyed.push(id); return { result: "ok" }; });
  // Save failed after an upload that nobody references -> delete it; shared -> keep it.
  await images.discardStagedUpload({ asset: { provider: "cloudinary", publicId: "unit-test-root/categories/orphan" } });
  model.docs.push({ _id: "other", icon: { publicId: "unit-test-root/categories/sharedNew" } });
  await images.discardStagedUpload({ asset: { provider: "cloudinary", publicId: "unit-test-root/categories/sharedNew" } });
  assert.deepEqual(destroyed, ["unit-test-root/categories/orphan"]);
  assert.equal((await images.discardStagedUpload(null)).status, "skipped");
});

test("URL classification helpers", () => {
  assert.equal(images.isCloudinaryUrl("https://res.cloudinary.com/x/image/upload/v1/a.png"), true);
  assert.equal(images.isLegacyUploadUrl("https://server.urbancitations.com/uploads/a.png"), true);
  assert.equal(images.isLegacyUploadUrl("https://res.cloudinary.com/x/image/upload/v1/urbancitations/uploads/a.png"), false);
  assert.equal(images.isLegacyUploadUrl("https://img.icons8.com/fluency/512/business.png"), false);
  assert.equal(images.folderFor("subcategory"), "unit-test-root/subcategories");
  assert.throws(() => images.folderFor("nope"));
});
