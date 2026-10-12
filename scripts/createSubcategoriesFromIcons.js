#!/usr/bin/env node
/**
 * Creates new SubCategory records, each with its icon stored in Cloudinary, from a
 * reviewed CSV (name, category, file). Used for the backed-up original icons that had
 * no subcategory yet (2026-10-10).
 *
 *   node scripts/createSubcategoriesFromIcons.js --csv <file> --icons <dir>                       # dry run (default)
 *   node scripts/createSubcategoriesFromIcons.js --csv <file> --icons <dir> --apply               # write (localhost MongoDB only)
 *   node scripts/createSubcategoriesFromIcons.js --csv <file> --icons <dir> --apply --production  # write against a non-localhost MongoDB
 *   node scripts/createSubcategoriesFromIcons.js --rollback <backup.json> [--apply [--production]]
 *
 * Options:
 *   --csv <file>        columns: name, category, file          (required)
 *   --icons <dir>       folder holding each `file`              (required)
 *   --skip <a,b>        slugs to leave out of this run
 *   --limit <n>         create only the first n rows
 *   --mongo-uri <uri>   MongoDB                (default MONGO_URI from .env)
 *   --root <folder>     Cloudinary root folder (default CLOUDINARY_ROOT_FOLDER or "urbancitations")
 *   --tag <tag>         Cloudinary tag         (default original-2026-10-10)
 *   --out <dir>         report directory       (default ./reports next to the CSV)
 *
 * Safety:
 *   - Dry run checks every row first: the file is a real PNG/JPEG, the category exists exactly
 *     once, and neither the slug (unique across all subcategories) nor name+category is taken.
 *     --apply refuses to run while any row has a problem.
 *   - Re-running is safe: a row whose subcategory already exists with the same name, category
 *     and icon is reported ALREADY_CREATED and left alone; Cloudinary public_ids are
 *     content-addressed, so no image is uploaded twice.
 *   - Every created document id is appended to scripts/backups/ as it is created;
 *     --rollback deletes exactly those documents (only if their icon is unchanged) and
 *     releases their Cloudinary images when nothing else references them.
 */
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const mongoose = require("mongoose");
const { detectKind } = require("../utils/uploadValidation");
const images = require("../services/imageStorageService");
const SubCategory = require("../models/SubCategory");
const Category = require("../models/Category");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => { const i = argv.indexOf(name); return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : fallback; };

const APPLY = flag("--apply");
const PRODUCTION = flag("--production");
const ROLLBACK = opt("--rollback", null);
const CSV_PATH = opt("--csv", null) && path.resolve(opt("--csv"));
const ICON_DIR = opt("--icons", null) && path.resolve(opt("--icons"));
const SKIP = new Set(String(opt("--skip", "")).split(",").map((s) => s.trim()).filter(Boolean));
const LIMIT = Number(opt("--limit", 0)) || 0;
const MONGO_URI = opt("--mongo-uri", process.env.MONGO_URI);
const TAG = opt("--tag", "original-2026-10-10");
const OUT_DIR = path.resolve(opt("--out", CSV_PATH ? path.join(path.dirname(CSV_PATH), "reports") : "reports"));
const BACKUP_DIR = path.join(__dirname, "backups");
const KIND = "subcategory";
if (opt("--root", null)) process.env.CLOUDINARY_ROOT_FOLDER = opt("--root", null);

const isLocalMongo = (uri) => /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(String(uri || ""));
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const fmt = (n) => Number(n).toLocaleString("en-US");
// Same rule as the SubCategory pre-save hook, so the checked slug is the one that gets stored.
const slugOf = (name) => name.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").trim();
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
const csvCell = (v) => { const s = v === undefined || v === null ? "" : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

function loadRows() {
  const rows = parseCsv(fs.readFileSync(CSV_PATH, "utf8"));
  const header = rows[0];
  const col = (n) => { const i = header.indexOf(n); if (i === -1) throw new Error(`CSV is missing column "${n}"`); return i; };
  const c = { name: col("name"), category: col("category"), file: col("file") };
  return rows.slice(1).filter((r) => r[c.name]).map((r) => {
    const name = r[c.name].trim();
    return { name, category: r[c.category].trim(), file: r[c.file], slug: slugOf(name), localPath: path.join(ICON_DIR, r[c.file]), problems: [] };
  });
}

async function check(rows) {
  const categories = await Category.find({}).select("_id name").lean();
  const byName = new Map();
  for (const cat of categories) { const k = cat.name.trim(); byName.set(k, [...(byName.get(k) || []), cat]); }
  const existing = await SubCategory.find({}).select("_id name slug category icon.sha256").lean();
  const bySlug = new Map(existing.map((d) => [d.slug, d]));
  const seen = new Map();
  for (const row of rows) {
    if (!fs.existsSync(row.localPath)) row.problems.push("icon file missing");
    else {
      row.buffer = fs.readFileSync(row.localPath);
      row.sha256 = images.sha256(row.buffer);
      const kind = detectKind(row.buffer);
      if (kind !== "png" && kind !== "jpeg") row.problems.push(`icon is ${kind || "not an image"}`);
      row.mimetype = kind === "jpeg" ? "image/jpeg" : "image/png";
    }
    const cats = byName.get(row.category) || [];
    if (cats.length !== 1) row.problems.push(cats.length ? `category "${row.category}" exists ${cats.length} times` : `category "${row.category}" not found`);
    else row.categoryId = String(cats[0]._id);
    if (!row.slug) row.problems.push("name gives an empty slug");
    if (seen.has(row.slug)) row.problems.push(`same slug as CSV row "${seen.get(row.slug)}"`);
    seen.set(row.slug, row.name);
    const taken = bySlug.get(row.slug);
    if (taken) {
      const same = taken.name === row.name && String(taken.category) === row.categoryId && taken.icon && taken.icon.sha256 === row.sha256;
      if (same) { row.status = "ALREADY_CREATED"; row.docId = String(taken._id); }
      else row.problems.push(`slug "${row.slug}" is already used by subcategory "${taken.name}" (${taken._id})`);
    } else if (row.categoryId) {
      const clash = existing.find((d) => String(d.category) === row.categoryId && d.name.toLowerCase() === row.name.toLowerCase());
      if (clash) row.problems.push(`"${clash.name}" already exists in this category (${clash._id})`);
    }
    if (!row.status) row.status = row.problems.length ? "BLOCKED" : "PENDING";
  }
}

function writeReport(file, rows) {
  const lines = ["name,category,slug,file,status,document_id,cloudinary_url,detail"];
  for (const r of rows) lines.push([r.name, r.category, r.slug, r.file, r.status, r.docId, r.url, r.problems.join("; ") || r.detail].map(csvCell).join(","));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n") + "\n");
}

async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) await fn(items[next++]); }));
}

async function rollback(file) {
  const backup = JSON.parse(fs.readFileSync(file, "utf8"));
  console.log(`Rollback of ${fmt(backup.created.length)} created subcategories from ${file}${APPLY ? "" : " (dry run)"}`);
  let removed = 0, kept = 0;
  for (const entry of backup.created) {
    const doc = await SubCategory.findById(entry._id).select("name icon iconUrl").lean();
    if (!doc) { console.log(`  - ${entry._id} ${entry.name}: already gone`); continue; }
    if (!doc.icon || doc.icon.publicId !== entry.publicId) { console.log(`  ! ${entry._id} ${entry.name}: icon changed since creation; kept`); kept++; continue; }
    if (APPLY) {
      await SubCategory.deleteOne({ _id: entry._id });
      const release = await images.releaseImage(doc.icon);
      console.log(`  ✓ deleted ${entry.name} (image: ${release.status}${release.reason ? `, ${release.reason}` : ""})`);
    }
    removed++;
  }
  console.log(`${APPLY ? "Deleted" : "Would delete"} ${fmt(removed)}; kept ${fmt(kept)}.`);
}

async function main() {
  if (!MONGO_URI) throw new Error("MONGO_URI is required (or pass --mongo-uri)");
  images.configure();
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 15_000 });
  const local = isLocalMongo(MONGO_URI);
  const dbLabel = `${mongoose.connection.host}/${mongoose.connection.name}`;
  console.log(`MongoDB: ${dbLabel} (${local ? "localhost" : "REMOTE"})  Cloudinary root: ${images.rootFolder()}/  Mode: ${APPLY ? "APPLY" : "DRY RUN"}`);
  if (APPLY && !local && !PRODUCTION) { console.log("\n❌ --apply against a non-localhost MongoDB requires --production. Nothing was changed."); process.exitCode = 2; return; }
  if (ROLLBACK) { await rollback(path.resolve(ROLLBACK)); return; }
  if (!CSV_PATH || !ICON_DIR) throw new Error("--csv and --icons are required");

  let rows = loadRows().filter((r) => !SKIP.has(r.slug));
  if (LIMIT) rows = rows.slice(0, LIMIT);
  await check(rows);
  const count = (s) => rows.filter((r) => r.status === s).length;
  console.log(`\nRows: ${fmt(rows.length)}${SKIP.size ? ` (skipped by --skip: ${[...SKIP].join(", ")})` : ""}   PENDING: ${fmt(count("PENDING"))}   ALREADY_CREATED: ${fmt(count("ALREADY_CREATED"))}   BLOCKED: ${fmt(count("BLOCKED"))}`);
  for (const r of rows.filter((x) => x.status === "BLOCKED").slice(0, 25)) console.log(`  ✗ ${r.name} [${r.category}]: ${r.problems.join("; ")}`);
  const perCat = {};
  for (const r of rows.filter((x) => x.status === "PENDING")) perCat[r.category] = (perCat[r.category] || 0) + 1;
  for (const [cat, n] of Object.entries(perCat).sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(4)}  ${cat}`);

  const runStamp = stamp();
  if (!APPLY) {
    const report = path.join(OUT_DIR, `dry-run-${runStamp}.csv`);
    writeReport(report, rows);
    console.log(`\nDry run only. Report: ${report}`);
    console.log(count("BLOCKED") ? "\n❌ STOP: fix the BLOCKED rows (or leave them out with --skip) before --apply." : `\n✅ Ready for --apply (${fmt(count("PENDING"))} subcategories to create).`);
    return;
  }
  if (count("BLOCKED")) { console.log("\n❌ BLOCKED rows present; nothing was changed. Run the dry run to see them."); process.exitCode = 1; return; }
  if (!count("PENDING")) { console.log("\nNothing to create: every row already exists. Nothing was changed."); return; }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const backupFile = path.join(BACKUP_DIR, `created-subcategories-${runStamp}.json`);
  const backup = { mongo: dbLabel, cloudinaryRoot: images.rootFolder(), csv: CSV_PATH, createdAt: new Date().toISOString(), created: [] };
  const saveBackup = () => fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2));
  saveBackup();

  let done = 0;
  const pending = rows.filter((r) => r.status === "PENDING");
  await pool(pending, 4, async (row) => {
    try {
      const { asset } = await images.uploadImage(row.buffer, { kind: KIND, filename: row.file, mimetype: row.mimetype, tags: [TAG, "new-subcategory"] });
      row.url = asset.url;
      // Re-check right before writing: someone may have created it since the dry run.
      if (await SubCategory.exists({ $or: [{ slug: row.slug }, { category: row.categoryId, name: new RegExp(`^${escapeRegex(row.name)}$`, "i") }] })) {
        row.status = "SKIPPED_EXISTS"; row.detail = "created by someone else since the check"; return;
      }
      const doc = new SubCategory({ id: 1, name: row.name, category: row.categoryId, iconUrl: asset.url, icon: asset });
      await doc.save();
      row.docId = String(doc._id);
      backup.created.push({ _id: row.docId, name: row.name, category: row.category, slug: doc.slug, publicId: asset.publicId });
      saveBackup();
      row.status = doc.slug === row.slug ? "CREATED" : "CREATED_SLUG_DIFFERS";
    } catch (error) {
      row.status = "FAILED"; row.detail = error.message;
    }
    done++;
    if (done % 50 === 0 || done === pending.length) console.log(`  ${fmt(done)}/${fmt(pending.length)} processed`);
  });

  const report = path.join(OUT_DIR, `apply-${runStamp}.csv`);
  writeReport(report, rows);
  console.log(`\nCREATED: ${fmt(count("CREATED") + count("CREATED_SLUG_DIFFERS"))}   ALREADY_CREATED: ${fmt(count("ALREADY_CREATED"))}   SKIPPED_EXISTS: ${fmt(count("SKIPPED_EXISTS"))}   FAILED: ${fmt(count("FAILED"))}`);
  console.log(`Report: ${report}\nBackup: ${backupFile}`);
  console.log(`Rollback: node scripts/createSubcategoriesFromIcons.js --rollback ${path.relative(process.cwd(), backupFile)} --apply${local ? "" : " --production"}`);
  if (count("FAILED")) { console.log("\n⚠️  Some rows failed; re-run the same command to finish (created rows are skipped)."); process.exitCode = 1; }
}

main()
  .catch((error) => { console.error(`\n❌ ${error.message}`); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
