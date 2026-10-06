#!/usr/bin/env node
"use strict";

/**
 * Migrates the recreated subcategory icon set to Cloudinary and re-points the
 * SubCategory documents at the Cloudinary assets.
 *
 *   node scripts/migrateSubcategoryIconsToCloudinary.js                        # DRY RUN (default): no Cloudinary or DB change
 *   node scripts/migrateSubcategoryIconsToCloudinary.js --apply                # write (localhost MongoDB only)
 *   node scripts/migrateSubcategoryIconsToCloudinary.js --apply --production   # write against a non-localhost (production) MongoDB
 *   node scripts/migrateSubcategoryIconsToCloudinary.js --rollback <backup.json> [--apply]
 *
 * Options
 *   --csv <file>        mapping CSV            (default ../recovered-uploads/reports/recreated-icons-final.csv)
 *   --icons <dir>       production-size files  (default ../recovered-uploads/recreated-subcategory-icons)
 *   --mongo-uri <uri>   MongoDB                (default MONGO_URI from .env)
 *   --root <folder>     Cloudinary root folder (default CLOUDINARY_ROOT_FOLDER or "urbancitations")
 *   --only <file>       newline-separated server filenames: migrate ONLY the artworks those files use,
 *                       together with every other server filename that shares the same artwork
 *   --limit <n>         migrate only the first n unique artworks (CSV order)
 *   --concurrency <n>   parallel Cloudinary uploads (default 4)
 *   --out <dir>         report directory       (default ../recovered-uploads/reports/cloudinary-migration)
 *   --expect-artworks <n> --expect-files <n>   expected counts for the full set (default 1408 / 2162)
 *   --no-url-check      skip the HTTP HEAD check of each secure_url before the DB update
 *
 * Safety
 *   - Dry run inspects every file, hashes it, validates the mapping and the DB match, and
 *     prints the summary below. It makes no Cloudinary and no MongoDB change.
 *   - --apply refuses to run unless MISSING LOCAL FILES, INVALID FILES and AMBIGUOUS MAPPINGS
 *     are all 0 and (for a full run) the counts equal the expected 1,408 / 2,162.
 *   - Each unique artwork is uploaded once (public_id = <root>/subcategories/<sha256>, overwrite:false),
 *     then every document that references it is updated with a guard on the old iconUrl, then the
 *     stored document is read back and verified. Upload failure -> no DB change for that artwork.
 *   - Resumable and idempotent: already-migrated documents are skipped, uploads of bytes that
 *     Cloudinary already holds return the existing asset, and <out>/state.json caches uploads.
 *   - Old /uploads files are never deleted. The pre-migration values of every document that
 *     will change are written to scripts/backups/ before the first write; --rollback restores them.
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const mongoose = require("mongoose");
const { detectKind } = require("../utils/uploadValidation");
const images = require("../services/imageStorageService");
const SubCategory = require("../models/SubCategory");
const Category = require("../models/Category");

const ROOT_DIR = path.join(__dirname, "../..");
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => { const i = argv.indexOf(name); return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : fallback; };

const APPLY = flag("--apply");
const PRODUCTION = flag("--production");
const ROLLBACK = opt("--rollback", null);
const CSV_PATH = path.resolve(opt("--csv", path.join(ROOT_DIR, "recovered-uploads/reports/recreated-icons-final.csv")));
const ICON_DIR = path.resolve(opt("--icons", path.join(ROOT_DIR, "recovered-uploads/recreated-subcategory-icons")));
const MONGO_URI = opt("--mongo-uri", process.env.MONGO_URI);
const OUT_DIR = path.resolve(opt("--out", path.join(ROOT_DIR, "recovered-uploads/reports/cloudinary-migration")));
const ONLY_FILE = opt("--only", null);
const LIMIT = Number(opt("--limit", 0)) || 0;
const CONCURRENCY = Math.max(1, Number(opt("--concurrency", 4)) || 4);
const EXPECT_ARTWORKS = Number(opt("--expect-artworks", 1408));
const EXPECT_FILES = Number(opt("--expect-files", 2162));
const URL_CHECK = !flag("--no-url-check");
const BACKUP_DIR = path.join(__dirname, "backups");
const STATE_FILE = path.join(OUT_DIR, "state.json");
const KIND = "subcategory";

if (opt("--root", null)) process.env.CLOUDINARY_ROOT_FOLDER = opt("--root", null);

const fmt = (n) => Number(n).toLocaleString("en-US");
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const isLocalMongo = (uri) => /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(String(uri || ""));

// ── CSV ─────────────────────────────────────────────────────────────────────
function parseCsv(text) {
  const rows = []; let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function csvCell(value) {
  const s = value === undefined || value === null ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function loadMapping() {
  const rows = parseCsv(fs.readFileSync(CSV_PATH, "utf8"));
  const header = rows[0];
  const col = (name) => { const i = header.indexOf(name); if (i === -1) throw new Error(`CSV is missing column "${name}"`); return i; };
  const c = { filename: col("filename"), category: col("category"), subcategory: col("subcategory"), sha256: col("sha256"), format: col("format"), width: col("width"), height: col("height"), master: col("master_path"), production: col("production_path") };
  return rows.slice(1).filter((r) => r.length >= header.length && r[c.filename]).map((r) => ({
    filename: r[c.filename], category: r[c.category], subcategory: r[c.subcategory], csvSha: r[c.sha256].toLowerCase(),
    format: r[c.format], width: Number(r[c.width]), height: Number(r[c.height]), master: r[c.master], localPath: path.join(ICON_DIR, r[c.filename]),
  }));
}

// ── local files ─────────────────────────────────────────────────────────────
function inspectFiles(rows) {
  const problems = { missing: [], invalid: [], ambiguous: [] };
  const seen = new Map();
  for (const row of rows) {
    if (seen.has(row.filename)) problems.ambiguous.push(`${row.filename}: listed ${seen.get(row.filename) + 1} times in the CSV`);
    seen.set(row.filename, (seen.get(row.filename) || 0) + 1);
    if (!fs.existsSync(row.localPath)) { problems.missing.push(row.filename); continue; }
    const buffer = fs.readFileSync(row.localPath);
    row.bytes = buffer.length;
    row.sha256 = images.sha256(buffer);
    const kind = detectKind(buffer);
    const expectedKind = row.format.toUpperCase() === "JPEG" ? "jpeg" : row.format.toLowerCase();
    if (buffer.length === 0) problems.invalid.push(`${row.filename}: empty file`);
    else if (kind !== expectedKind) problems.invalid.push(`${row.filename}: content is ${kind}, CSV says ${row.format}`);
    else if (/<\?php|<script|<html|<iframe/i.test(buffer.toString("latin1"))) problems.invalid.push(`${row.filename}: embedded script content`);
    else if (row.sha256 !== row.csvSha) problems.invalid.push(`${row.filename}: SHA-256 ${row.sha256.slice(0, 12)}… differs from the CSV (${row.csvSha.slice(0, 12)}…)`);
  }
  // Reuse consistency: one artwork (sha) ↔ one master; two masters never share bytes.
  const masterBySha = new Map();
  const shaByMaster = new Map();
  for (const row of rows) {
    if (!row.sha256) continue;
    if (masterBySha.has(row.sha256) && masterBySha.get(row.sha256) !== row.master) problems.ambiguous.push(`${row.filename}: artwork ${row.sha256.slice(0, 12)}… is attributed to two masters`);
    masterBySha.set(row.sha256, row.master);
    if (shaByMaster.has(row.master) && shaByMaster.get(row.master) !== row.sha256) problems.ambiguous.push(`${row.filename}: master ${row.master} has two different byte contents`);
    shaByMaster.set(row.master, row.sha256);
  }
  return problems;
}

// ── DB ──────────────────────────────────────────────────────────────────────
function filenameFromUrl(url) {
  const marker = "/uploads/";
  const i = String(url || "").indexOf(marker);
  if (i === -1) return null;
  const raw = String(url).slice(i + marker.length);
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { /* keep raw */ }
  return { raw, decoded };
}

// A document is "legacy-referenced" when its iconUrl still points at /uploads/, or when it
// was migrated earlier and its icon.legacyUrl records the /uploads/ URL it came from.
function legacyUrlOf(doc) {
  if (/\/uploads\//.test(doc.iconUrl || "")) return doc.iconUrl;
  if (doc.icon && /\/uploads\//.test(doc.icon.legacyUrl || "")) return doc.icon.legacyUrl;
  return null;
}

async function loadDocuments() {
  const docs = await SubCategory.find({ $or: [{ iconUrl: /\/uploads\// }, { "icon.legacyUrl": /\/uploads\// }] }).select("_id name iconUrl icon category").lean();
  const categoryIds = [...new Set(docs.map((d) => String(d.category)))];
  const categories = await Category.find({ _id: { $in: categoryIds } }).select("_id name").lean();
  const categoryName = new Map(categories.map((c) => [String(c._id), c.name]));
  const byFilename = new Map();
  for (const d of docs) {
    d.categoryName = categoryName.get(String(d.category)) || "";
    d.legacyUrl = legacyUrlOf(d);
    const names = filenameFromUrl(d.legacyUrl);
    if (!names) continue;
    for (const key of new Set([names.raw, names.decoded])) {
      if (!byFilename.has(key)) byFilename.set(key, []);
      byFilename.get(key).push(d);
    }
  }
  return { docs, byFilename };
}

function matchDocuments(rows, byFilename, problems) {
  for (const row of rows) {
    const matches = (byFilename.get(row.filename) || []);
    const unique = [...new Map(matches.map((d) => [String(d._id), d])).values()];
    row.docs = unique;
    if (unique.length === 0) problems.ambiguous.push(`${row.filename}: no SubCategory document references it`);
    else if (unique.length > 1) problems.ambiguous.push(`${row.filename}: referenced by ${unique.length} documents (${unique.map((d) => d._id).join(", ")})`);
  }
}

function classify(rows) {
  for (const row of rows) {
    const doc = row.docs && row.docs[0];
    row.publicId = row.sha256 ? images.publicIdFor(KIND, row.sha256) : null;
    if (!doc) { row.status = "NO_DOCUMENT"; continue; }
    row.docId = String(doc._id);
    row.oldIconUrl = doc.legacyUrl || doc.iconUrl;
    if (doc.icon && doc.icon.publicId === row.publicId && doc.iconUrl === doc.icon.url) row.status = "ALREADY_MIGRATED";
    else if (doc.icon && doc.icon.publicId) row.status = "SKIPPED_OTHER_CLOUDINARY_ASSET";
    else row.status = "PENDING";
  }
}

// ── state / reports ─────────────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return { uploads: {} }; }
}
function saveState(state) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

const REPORT_COLUMNS = ["document_id", "category", "subcategory", "server_filename", "old_image_reference", "new_cloudinary_public_id", "new_cloudinary_url", "sha256", "migration_status", "detail"];
function writeReport(file, rows) {
  const lines = [REPORT_COLUMNS.join(",")];
  for (const r of rows) {
    lines.push([r.docId || "", r.category, r.subcategory, r.filename, r.oldIconUrl || "", r.publicId || "", r.newUrl || "", r.sha256 || "", r.status, r.detail || ""].map(csvCell).join(","));
  }
  fs.writeFileSync(file, lines.join("\n") + "\n");
}

async function headOk(url) {
  try {
    const res = await fetch(url, { method: "HEAD" });
    const type = res.headers.get("content-type") || "";
    return res.ok && type.startsWith("image/") ? null : `HTTP ${res.status} ${type}`.trim();
  } catch (error) { return error.message; }
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() { while (next < items.length) { const i = next++; results[i] = await worker(items[i], i); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

// ── rollback ────────────────────────────────────────────────────────────────
async function rollback(file) {
  const backup = JSON.parse(fs.readFileSync(file, "utf8"));
  const entries = backup.documents || backup;
  console.log(`Rollback of ${fmt(entries.length)} document(s) from ${file} (${APPLY ? "APPLY" : "DRY RUN"}). Cloudinary assets are NOT deleted.`);
  let restored = 0;
  for (const entry of entries) {
    const update = { $set: { iconUrl: entry.iconUrl } };
    if (entry.icon) update.$set.icon = entry.icon; else update.$unset = { icon: "" };
    if (APPLY) {
      const result = await SubCategory.collection.updateOne({ _id: new mongoose.Types.ObjectId(entry._id) }, update);
      if (result.matchedCount === 1) restored++;
      else console.log(`  ! ${entry._id} not found`);
    } else restored++;
  }
  console.log(`${APPLY ? "Restored" : "Would restore"} ${fmt(restored)} document(s).`);
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  if (!MONGO_URI) throw new Error("MONGO_URI is required (or pass --mongo-uri)");
  images.configure(); // fails fast when CLOUDINARY_* is missing
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 15_000 });
  const dbLabel = `${mongoose.connection.host}/${mongoose.connection.name}`;
  const local = isLocalMongo(MONGO_URI);
  console.log(`MongoDB: ${dbLabel} (${local ? "localhost" : "REMOTE"})  Cloudinary root: ${images.rootFolder()}/  Mode: ${APPLY ? "APPLY" : "DRY RUN"}`);

  if (ROLLBACK) { await rollback(path.resolve(ROLLBACK)); return; }

  if (APPLY && !local && !PRODUCTION) {
    console.log("\n❌ --apply against a non-localhost MongoDB requires --production. Nothing was changed.");
    process.exitCode = 2;
    return;
  }

  // 1. local files
  let rows = loadMapping();
  const totalFiles = rows.length;
  const problems = inspectFiles(rows);
  const allArtworks = new Set(rows.filter((r) => r.sha256).map((r) => r.sha256));

  // 2. documents
  const { docs, byFilename } = await loadDocuments();
  matchDocuments(rows, byFilename, problems);
  const managed = new Set(rows.map((r) => r.filename));
  const unmanaged = docs.filter((d) => { const n = filenameFromUrl(d.legacyUrl); return n && !managed.has(n.raw) && !managed.has(n.decoded); });

  // 3. subset selection (--only / --limit) keeps whole artworks so reuse relationships stay intact
  let subset = false;
  if (ONLY_FILE) {
    const wanted = new Set(fs.readFileSync(path.resolve(ONLY_FILE), "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    const unknown = [...wanted].filter((w) => !managed.has(w));
    if (unknown.length) throw new Error(`--only lists ${unknown.length} filename(s) not in the CSV: ${unknown.slice(0, 5).join(", ")}`);
    const shas = new Set(rows.filter((r) => wanted.has(r.filename)).map((r) => r.sha256));
    rows = rows.filter((r) => shas.has(r.sha256));
    subset = true;
  }
  if (LIMIT) {
    const shas = new Set();
    for (const r of rows) { if (shas.size >= LIMIT && !shas.has(r.sha256)) continue; shas.add(r.sha256); }
    rows = rows.filter((r) => shas.has(r.sha256));
    subset = true;
  }
  classify(rows);
  const artworks = new Set(rows.filter((r) => r.sha256).map((r) => r.sha256));
  const pending = rows.filter((r) => r.status === "PENDING");
  const pendingArtworks = new Set(pending.map((r) => r.sha256));
  const count = (status) => rows.filter((r) => r.status === status).length;

  // 4. summary (the gate for --apply)
  console.log(`\nEXPECTED UNIQUE ARTWORKS: ${fmt(EXPECT_ARTWORKS)}   found in CSV/disk: ${fmt(allArtworks.size)}${subset ? `   selected: ${fmt(artworks.size)}` : ""}`);
  console.log(`EXPECTED SERVER FILENAMES: ${fmt(EXPECT_FILES)}   found in CSV: ${fmt(totalFiles)}${subset ? `   selected: ${fmt(rows.length)}` : ""}`);
  console.log(`MISSING LOCAL FILES: ${fmt(problems.missing.length)}`);
  console.log(`INVALID FILES: ${fmt(problems.invalid.length)}`);
  console.log(`AMBIGUOUS MAPPINGS: ${fmt(problems.ambiguous.length)}`);
  console.log(`\nSubCategory documents with legacy /uploads/ icons (current or migrated-from): ${fmt(docs.length)}   matched to the CSV: ${fmt(docs.length - unmanaged.length)}   not in the CSV (left untouched): ${fmt(unmanaged.length)}`);
  console.log(`Selected documents: ${fmt(rows.length)}   PENDING: ${fmt(pending.length)} (${fmt(pendingArtworks.size)} artworks to upload)   ALREADY_MIGRATED: ${fmt(count("ALREADY_MIGRATED"))}   SKIPPED_OTHER_CLOUDINARY_ASSET: ${fmt(count("SKIPPED_OTHER_CLOUDINARY_ASSET"))}   NO_DOCUMENT: ${fmt(count("NO_DOCUMENT"))}`);
  for (const [label, list] of Object.entries(problems)) if (list.length) console.log(`\n${label.toUpperCase()} (${list.length}):\n  ${list.slice(0, 15).join("\n  ")}${list.length > 15 ? `\n  … and ${list.length - 15} more` : ""}`);
  if (unmanaged.length) console.log(`\nDocuments with /uploads/ icons not covered by the CSV (first 10):\n  ${unmanaged.slice(0, 10).map((d) => `${d._id} ${d.iconUrl}`).join("\n  ")}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const runStamp = stamp();
  const reportFile = path.join(OUT_DIR, `${APPLY ? "apply" : "dry-run"}-${runStamp}.csv`);

  const countsOk = subset || (allArtworks.size === EXPECT_ARTWORKS && totalFiles === EXPECT_FILES);
  const blocked = problems.missing.length || problems.invalid.length || problems.ambiguous.length || !countsOk;

  if (!APPLY) {
    for (const r of rows) if (r.status === "PENDING") { r.status = "WOULD_MIGRATE"; r.newUrl = ""; }
    writeReport(reportFile, rows);
    console.log(`\nDry run only. Report: ${reportFile}`);
    console.log(blocked ? `\n❌ STOP: fix the problems above before --apply.${countsOk ? "" : " Counts do not match the expected full set."}` : `\n✅ Ready for --apply (${fmt(pendingArtworks.size)} uploads, ${fmt(pending.length)} document updates).`);
    if (blocked) process.exitCode = 1;
    return;
  }
  if (blocked) {
    writeReport(reportFile, rows);
    console.log(`\n❌ Not applied: problems above${countsOk ? "" : " and the counts do not match the expected full set"}. Nothing was changed. Report: ${reportFile}`);
    process.exitCode = 1;
    return;
  }
  if (!pending.length) { writeReport(reportFile, rows); console.log(`\nNothing to do: every selected document is already migrated. Report: ${reportFile}`); return; }

  // 5. backup of every document that will change (before the first write)
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const backupFile = path.join(BACKUP_DIR, `subcategory-icons-cloudinary-${runStamp}.json`);
  fs.writeFileSync(backupFile, JSON.stringify({
    createdAt: new Date().toISOString(), mongo: dbLabel, cloudinaryRoot: images.rootFolder(),
    documents: pending.map((r) => ({ _id: r.docId, iconUrl: r.oldIconUrl, icon: r.docs[0].icon || null, subcategory: r.subcategory, category: r.category, server_filename: r.filename })),
  }, null, 2));
  console.log(`\nBackup of the ${fmt(pending.length)} document(s) about to change: ${backupFile}`);

  // 6. upload each unique artwork once, then update + verify every document that uses it
  const state = loadState();
  state.uploads = state.uploads || {};
  const bySha = new Map();
  for (const r of pending) { if (!bySha.has(r.sha256)) bySha.set(r.sha256, []); bySha.get(r.sha256).push(r); }
  const tally = { uploaded: 0, existing: 0, cached: 0, uploadFailed: 0, migrated: 0, dbSkipped: 0, verifyFailed: 0, urlFailed: 0 };
  let done = 0;

  await mapLimit([...bySha.entries()], CONCURRENCY, async ([sha, group]) => {
    const first = group[0];
    let asset = state.uploads[sha] && state.uploads[sha].publicId === first.publicId ? state.uploads[sha] : null;
    if (asset) tally.cached++;
    else {
      try {
        const buffer = fs.readFileSync(first.localPath);
        const result = await images.uploadImage(buffer, { kind: KIND, filename: first.filename, mimetype: first.format.toUpperCase() === "JPEG" ? "image/jpeg" : "image/png", tags: ["recreated-2026-10-06", "migration"] });
        asset = { ...result.asset, uploadedAt: new Date().toISOString() };
        delete asset.legacyUrl;
        if (result.existing) tally.existing++; else tally.uploaded++;
        state.uploads[sha] = asset;
        saveState(state);
      } catch (error) {
        tally.uploadFailed++;
        for (const r of group) { r.status = "UPLOAD_FAILED"; r.detail = error.message; }
        return;
      }
    }
    if (URL_CHECK) {
      const problem = await headOk(asset.url);
      if (problem) { tally.urlFailed++; for (const r of group) { r.status = "URL_UNREACHABLE"; r.detail = problem; r.newUrl = asset.url; } return; }
    }
    for (const r of group) {
      r.newUrl = asset.url;
      const icon = { ...asset, uploadedAt: new Date(asset.uploadedAt), legacyUrl: r.oldIconUrl };
      try {
        const result = await SubCategory.collection.updateOne(
          { _id: new mongoose.Types.ObjectId(r.docId), iconUrl: r.docs[0].iconUrl },   // guard: unchanged since it was read
          { $set: { iconUrl: asset.url, icon } }
        );
        if (result.matchedCount !== 1) { r.status = "DB_UPDATE_SKIPPED"; r.detail = "document changed since it was read; not updated"; tally.dbSkipped++; continue; }
        const stored = await SubCategory.findById(r.docId).select("iconUrl icon.publicId").lean();
        if (stored && stored.icon && stored.icon.publicId === asset.publicId && stored.iconUrl === asset.url) { r.status = "MIGRATED"; tally.migrated++; }
        else { r.status = "VERIFY_FAILED"; r.detail = "stored document does not point at the new asset"; tally.verifyFailed++; }
      } catch (error) { r.status = "DB_UPDATE_FAILED"; r.detail = error.message; tally.dbSkipped++; }
    }
    done++;
    if (done % 50 === 0 || done === bySha.size) console.log(`  ${fmt(done)}/${fmt(bySha.size)} artworks processed`);
  });

  writeReport(reportFile, rows);
  fs.writeFileSync(path.join(OUT_DIR, `apply-${runStamp}-summary.json`), JSON.stringify({ mongo: dbLabel, cloudinaryRoot: images.rootFolder(), backupFile, reportFile, tally, selected: rows.length, artworks: bySha.size }, null, 2));
  console.log(`\nUploads: new ${fmt(tally.uploaded)}, already in Cloudinary ${fmt(tally.existing)}, from state cache ${fmt(tally.cached)}, failed ${fmt(tally.uploadFailed)}, URL unreachable ${fmt(tally.urlFailed)}`);
  console.log(`Documents: MIGRATED ${fmt(tally.migrated)}, DB_UPDATE_SKIPPED/FAILED ${fmt(tally.dbSkipped)}, VERIFY_FAILED ${fmt(tally.verifyFailed)}`);
  console.log(`Report: ${reportFile}\nRollback: node scripts/migrateSubcategoryIconsToCloudinary.js --rollback ${path.relative(process.cwd(), backupFile)} --apply${local ? "" : " --production"} --mongo-uri <same uri>`);
  if (tally.uploadFailed || tally.dbSkipped || tally.verifyFailed || tally.urlFailed) { console.log("\n⚠️  Some rows did not migrate; re-run the same command to resume (nothing is uploaded twice)."); process.exitCode = 1; }
}

main()
  .catch((error) => { console.error("\n❌", error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
