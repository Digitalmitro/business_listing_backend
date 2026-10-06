"use strict";

/**
 * Permanent image storage for Admin-managed images (Cloudinary).
 *
 * Admin → backend upload API → validate bytes → Cloudinary (signed, server-side)
 *       → secure_url/public_id stored in MongoDB → Admin/frontend read the URL from the API.
 *
 * Nothing here touches the local filesystem: files arrive as multer memory buffers.
 *
 * Public IDs are content-addressed: `<root>/<folder>/<sha256 of the bytes>`, uploaded
 * with `overwrite:false`. Uploading identical bytes twice therefore returns the existing
 * asset instead of a duplicate, which makes migrations idempotent and makes "is this
 * asset still referenced?" a plain DB query on `<field>.publicId`.
 *
 * Environment:
 *   CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET  (required)
 *   CLOUDINARY_ROOT_FOLDER   root folder, default "urbancitations"
 *                            (local tests use another root so they never mix with production assets)
 */

const crypto = require("node:crypto");
const cloudinary = require("cloudinary").v2;
const logger = require("../utils/logger");
const { validateImageBuffer } = require("../utils/uploadValidation");

const PROVIDER = "cloudinary";
const DEFAULT_ROOT_FOLDER = "urbancitations";

// Entity kind → folder under the root. Add entries here when another entity moves to Cloudinary.
const FOLDERS = Object.freeze({
  category: "categories",
  subcategory: "subcategories",
  banner: "banners",
  topBannerCategory: "top-banner-categories",
  topService: "top-services",
  freeListing: "free-listings",
  popularSearch: "popular-searches",
  topCountry: "top-countries",
  blog: "blog",
});

class ImageStorageError extends Error {
  constructor(message, { status = 502, cause } = {}) {
    super(message);
    this.name = "ImageStorageError";
    this.status = status;
    this.isOperational = true;
    if (cause) this.cause = cause;
  }
}

function rootFolder() {
  return String(process.env.CLOUDINARY_ROOT_FOLDER || DEFAULT_ROOT_FOLDER).replace(/^\/+|\/+$/g, "");
}

function folderFor(kind) {
  const folder = FOLDERS[kind];
  if (!folder) throw new ImageStorageError(`Unknown image kind "${kind}".`, { status: 500 });
  return `${rootFolder()}/${folder}`;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function publicIdFor(kind, hash) {
  return `${folderFor(kind)}/${hash}`;
}

function isConfigured() {
  return Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
}

function configure() {
  if (!isConfigured()) {
    throw new ImageStorageError("Image storage is not configured (CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET are required).", { status: 503 });
  }
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
  return cloudinary;
}

function messageOf(error) {
  if (!error) return "unknown error";
  if (typeof error === "string") return error;
  return error.message || (error.error && error.error.message) || JSON.stringify(error);
}

// The only place that talks to the Cloudinary SDK, so tests can stub it.
const cloudinaryClient = {
  uploadBuffer(buffer, options) {
    const sdk = configure();
    return new Promise((resolve, reject) => {
      const stream = sdk.uploader.upload_stream(options, (error, result) => (error ? reject(error) : resolve(result)));
      stream.end(buffer);
    });
  },
  destroy(publicId, options) {
    return configure().uploader.destroy(publicId, options);
  },
};

function toAsset(result, { sha256: hash, legacyUrl } = {}) {
  const asset = {
    provider: PROVIDER,
    url: result.secure_url,
    publicId: result.public_id,
    resourceType: result.resource_type || "image",
    format: result.format,
    width: result.width,
    height: result.height,
    bytes: result.bytes,
    version: result.version,
    sha256: hash,
    uploadedAt: new Date(),
  };
  if (legacyUrl) asset.legacyUrl = legacyUrl;
  return asset;
}

/**
 * Validates the bytes (extension, MIME, real signature, embedded script markers) and
 * uploads them. Resolves `{ asset, existing }`; `existing` is true when Cloudinary already
 * held identical bytes under the same public_id (nothing was re-uploaded).
 * Rejects with ImageStorageError: status 400 for invalid images, 502 for Cloudinary failures.
 */
async function uploadImage(buffer, { kind, filename, mimetype, legacyUrl, tags = [] } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ImageStorageError("No image data was received.", { status: 400 });
  }
  const problem = validateImageBuffer(buffer, { filename, mimetype });
  if (problem) throw new ImageStorageError(problem, { status: 400 });

  const hash = sha256(buffer);
  const publicId = publicIdFor(kind, hash);
  let result;
  try {
    result = await cloudinaryClient.uploadBuffer(buffer, {
      public_id: publicId,
      resource_type: "image",
      type: "upload",
      overwrite: false,
      unique_filename: false,
      use_filename: false,
      invalidate: false,
      tags: [rootFolder(), kind, ...tags],
      timeout: 60_000,
    });
  } catch (error) {
    logger.error("image_storage.upload_failed", "Cloudinary upload failed", { kind, publicId, bytes: buffer.length, error });
    throw new ImageStorageError(`Image upload failed: ${messageOf(error)}`, { cause: error });
  }
  if (!result || !result.secure_url || !result.public_id) {
    throw new ImageStorageError("Cloudinary returned an incomplete upload response.");
  }
  const asset = toAsset(result, { sha256: hash, legacyUrl });
  logger.info("image_storage.uploaded", "Image stored in Cloudinary", {
    kind, publicId: asset.publicId, bytes: asset.bytes, format: asset.format, width: asset.width, height: asset.height, existing: Boolean(result.existing),
  });
  return { asset, existing: Boolean(result.existing) };
}

/** Deletes one asset. Resolves "ok" or "not found"; rejects with ImageStorageError otherwise. */
async function deleteImage(publicId) {
  let response;
  try {
    response = await cloudinaryClient.destroy(publicId, { resource_type: "image", invalidate: true });
  } catch (error) {
    throw new ImageStorageError(`Image delete failed for ${publicId}: ${messageOf(error)}`, { cause: error });
  }
  const outcome = response && response.result;
  if (outcome === "ok" || outcome === "not found") return outcome;
  throw new ImageStorageError(`Image delete failed for ${publicId}: ${outcome || "unexpected response"}`);
}

// ── Reference tracking ──────────────────────────────────────────────────────
// Models that embed an ImageAsset register the field here (see models/Category.js),
// so a Cloudinary asset is only ever deleted when no document points at it.
const referenceSources = [];

function registerImageField(model, field) {
  if (!referenceSources.some((s) => s.model === model && s.field === field)) referenceSources.push({ model, field });
}

async function countReferences(publicId, { exclude } = {}) {
  const byModel = [];
  let total = 0;
  for (const { model, field } of referenceSources) {
    const query = { [`${field}.publicId`]: publicId };
    if (exclude && exclude.modelName === model.modelName && exclude.id) query._id = { $ne: exclude.id };
    const count = await model.countDocuments(query);
    if (count) byModel.push({ model: model.modelName, field, count });
    total += count;
  }
  return { total, byModel };
}

/**
 * Deletes the Cloudinary asset behind `asset` unless another document still references
 * it. Never throws: the caller has already made the DB consistent, so a failed or skipped
 * delete only leaves an unreferenced asset behind, which is logged for cleanup.
 * Resolves { status: "deleted" | "kept" | "skipped" | "failed", ... }.
 */
async function releaseImage(asset, { exclude } = {}) {
  if (!asset || asset.provider !== PROVIDER || !asset.publicId) return { status: "skipped", reason: "not a Cloudinary asset" };
  let references;
  try {
    references = await countReferences(asset.publicId, { exclude });
  } catch (error) {
    logger.error("image_storage.release_check_failed", "Could not check references; asset kept", { publicId: asset.publicId, error });
    return { status: "failed", error: messageOf(error) };
  }
  if (references.total > 0) {
    logger.info("image_storage.release_kept_shared", "Asset kept: still referenced", { publicId: asset.publicId, references });
    return { status: "kept", references: references.total, byModel: references.byModel };
  }
  try {
    const result = await deleteImage(asset.publicId);
    logger.info("image_storage.released", "Unreferenced asset deleted", { publicId: asset.publicId, result });
    return { status: "deleted", result };
  } catch (error) {
    logger.error("image_storage.release_failed", "Unreferenced asset could not be deleted", { publicId: asset.publicId, error });
    return { status: "failed", error: messageOf(error) };
  }
}

// ── Document helpers (shared by the Category and SubCategory controllers) ───

function defaultUrlFor(model, urlField) {
  const schemaPath = model.schema.path(urlField);
  const value = schemaPath && schemaPath.options && schemaPath.options.default;
  return typeof value === "function" ? value() : value;
}

function plainAsset(asset) {
  if (!asset) return null;
  return typeof asset.toObject === "function" ? asset.toObject() : { ...asset };
}

/**
 * Uploads `file` (multer memory file) and points `doc[field]`/`doc[urlField]` at it in
 * memory only. Nothing is saved; the caller saves the document and then calls
 * `finishImageChange` so the previous asset is released only after the save succeeded.
 */
async function stageImageUpload(doc, file, { kind, field = "icon", urlField = "iconUrl" }) {
  if (!file || !file.buffer) throw new ImageStorageError("No image file was received.", { status: 400 });
  const previous = plainAsset(doc[field]);
  // Remember the URL being replaced only when it is a real legacy image (not the schema
  // placeholder and not a Cloudinary asset, which is already recorded in `previous`).
  const currentUrl = doc.isNew ? null : doc[urlField];
  const legacyUrl = !previous && currentUrl && currentUrl !== defaultUrlFor(doc.constructor, urlField) ? currentUrl : undefined;
  const { asset, existing } = await uploadImage(file.buffer, { kind, filename: file.originalname, mimetype: file.mimetype, legacyUrl });
  doc[field] = asset;
  doc[urlField] = asset.url;
  return { asset, previous, existing };
}

/** Clears the image in memory (back to the schema default URL). Save, then `finishImageChange`. */
function stageImageRemoval(doc, { field = "icon", urlField = "iconUrl" } = {}) {
  const previous = plainAsset(doc[field]);
  doc[field] = undefined;
  doc[urlField] = defaultUrlFor(doc.constructor, urlField);
  return { asset: null, previous };
}

/**
 * After a successful save: verifies the stored document really points at the new asset,
 * then releases the previous one if it is no longer referenced anywhere.
 * Returns { verified, release }.
 */
async function finishImageChange(doc, { asset, previous }, { field = "icon" } = {}) {
  const model = doc.constructor;
  const stored = await model.findById(doc._id).select(field).lean();
  const storedId = stored && stored[field] ? stored[field].publicId : null;
  const expectedId = asset ? asset.publicId : null;
  const verified = Boolean(stored) && storedId === expectedId;
  if (!verified) {
    logger.error("image_storage.verify_failed", "Stored document does not point at the expected asset; previous asset kept", {
      model: model.modelName, id: String(doc._id), expectedId, storedId,
    });
    return { verified: false, release: { status: "skipped", reason: "verification failed" } };
  }
  if (!previous || !previous.publicId || previous.publicId === expectedId) return { verified: true, release: { status: "skipped", reason: "no previous asset or unchanged" } };
  const release = await releaseImage(previous);
  return { verified: true, release };
}

/**
 * Save failed after an upload: releases the just-uploaded asset unless another document
 * already uses it, so a failed request leaves no orphan behind.
 */
async function discardStagedUpload(staged) {
  if (!staged || !staged.asset) return { status: "skipped" };
  return releaseImage(staged.asset);
}

/** Record deleted: release its asset if nothing else references it. */
async function releaseDocumentImage(doc, { field = "icon" } = {}) {
  return releaseImage(plainAsset(doc && doc[field]));
}

function isCloudinaryUrl(url) {
  return /^https?:\/\/res\.cloudinary\.com\//i.test(String(url || ""));
}

function isLegacyUploadUrl(url) {
  return /\/uploads\//.test(String(url || "")) && !isCloudinaryUrl(url);
}

module.exports = {
  PROVIDER,
  FOLDERS,
  ImageStorageError,
  cloudinaryClient,
  configure,
  isConfigured,
  rootFolder,
  folderFor,
  publicIdFor,
  sha256,
  toAsset,
  uploadImage,
  deleteImage,
  registerImageField,
  countReferences,
  releaseImage,
  stageImageUpload,
  stageImageRemoval,
  finishImageChange,
  discardStagedUpload,
  releaseDocumentImage,
  defaultUrlFor,
  isCloudinaryUrl,
  isLegacyUploadUrl,
};
