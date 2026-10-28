#!/usr/bin/env node
/**
 * Give subcategories that still show the default placeholder icon a real icon (stored in Cloudinary).
 * Used for "Icons 1001-2000.rar" (2026-10-24).
 *
 *   node scripts/assignSubcategoryIcons.js --csv <file> --icons <dir>                         dry run (default)
 *   node scripts/assignSubcategoryIcons.js --csv <file> --icons <dir> --apply --production    write against a non-localhost MongoDB
 *   node scripts/assignSubcategoryIcons.js --rollback scripts/backups/assigned-subcategory-icons-<stamp>.json [--apply --production]
 *
 *   --csv <file>        columns: id, name, file[, expect_url]    (one row per subcategory document)
 *                       expect_url (optional): replace an existing icon, but only while the document
 *                       still shows exactly this URL; without it only default-icon documents change
 *   --icons <dir>       folder holding each `file`
 *   --mongo-uri <uri>   MongoDB                (default MONGO_URI from .env)
 *   --root <folder>     Cloudinary root folder (default CLOUDINARY_ROOT_FOLDER or "urbancitations")
 *   --tag <tag>         Cloudinary tag         (default icons-1001-2000)
 *   --out <dir>         report directory       (default ./reports next to the CSV)
 *
 * Safety:
 *   - Only a document whose iconUrl is still the schema default is changed (checked again in the
 *     update filter, so an icon set by an admin in the meantime is never overwritten).
 *   - Cloudinary public_ids are content-addressed: re-runs upload nothing twice and are no-ops.
 *   - The backup lists every changed document with its previous icon; --rollback restores that icon
 *     (or the default) if the document still shows the icon this script gave it. Cloudinary images are left in place.
 */
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const mongoose = require("mongoose");
const { detectKind } = require("../utils/uploadValidation");
const images = require("../services/imageStorageService");
const SubCategory = require("../models/SubCategory");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => { const i = argv.indexOf(name); return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : fallback; };

const APPLY = flag("--apply");
const PRODUCTION = flag("--production");
const ROLLBACK = opt("--rollback", null);
const CSV_PATH = opt("--csv", null) && path.resolve(opt("--csv"));
const ICON_DIR = opt("--icons", null) && path.resolve(opt("--icons"));
const MONGO_URI = opt("--mongo-uri", process.env.MONGO_URI);
const TAG = opt("--tag", "icons-1001-2000");
const OUT_DIR = path.resolve(opt("--out", CSV_PATH ? path.join(path.dirname(CSV_PATH), "reports") : "reports"));
const BACKUP_DIR = path.join(__dirname, "backups");
const DEFAULT_ICON = SubCategory.schema.path("iconUrl").defaultValue;
if (opt("--root", null)) process.env.CLOUDINARY_ROOT_FOLDER = opt("--root", null);

const isLocalMongo = (uri) => /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(String(uri || ""));
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const csvCell = (v) => { const s = v === undefined || v === null ? "" : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [header, ...body] = rows.filter((r) => r.some((c) => c.trim()));
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i]])));
}

async function connect() {
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 15_000 });
  } catch (err) {
    // A flaky local resolver (VPN, Private Relay, Wi-Fi switch) can refuse the mongodb+srv lookup; retry once via public DNS.
    if (err.syscall !== "querySrv") throw err;
    console.log(`⚠ ${err.message}; retrying the lookup via public DNS (8.8.8.8, 1.1.1.1)`);
    require("dns").setServers(["8.8.8.8", "1.1.1.1"]);
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 15_000 });
  }
}

async function rollback(file) {
  const backup = JSON.parse(fs.readFileSync(file, "utf8"));
  console.log(`Rollback of ${backup.assigned.length} subcategories from ${file}${APPLY ? "" : " (dry run)"}`);
  let restored = 0;
  for (const entry of backup.assigned) {
    const doc = await SubCategory.findById(entry._id).select("name iconUrl").lean();
    if (!doc) { console.log(`  - ${entry.name}: document gone`); continue; }
    if (doc.iconUrl !== entry.iconUrl) { console.log(`  ! ${entry.name}: icon changed since; kept`); continue; }
    const previousUrl = entry.previousUrl || DEFAULT_ICON;
    const update = previousUrl === DEFAULT_ICON || !entry.previousIcon
      ? { $set: { iconUrl: previousUrl, updatedAt: new Date() }, $unset: { icon: "" } }
      : { $set: { iconUrl: previousUrl, icon: entry.previousIcon, updatedAt: new Date() } };
    if (APPLY) await SubCategory.updateOne({ _id: entry._id, iconUrl: entry.iconUrl }, update);
    console.log(`  ✓ ${entry.name} → ${previousUrl === DEFAULT_ICON ? "default icon" : previousUrl}`);
    restored++;
  }
  console.log(`${APPLY ? "Restored" : "Would restore"} ${restored}.`);
}

async function main() {
  if (!MONGO_URI) throw new Error("MONGO_URI is required (or pass --mongo-uri)");
  await connect();
  const local = isLocalMongo(MONGO_URI);
  console.log(`MongoDB: ${mongoose.connection.host}/${mongoose.connection.name} (${local ? "localhost" : "REMOTE"})  Mode: ${APPLY ? "APPLY" : "DRY RUN"}  Cloudinary root: ${process.env.CLOUDINARY_ROOT_FOLDER || "urbancitations"}`);
  if (APPLY && !local && !PRODUCTION) { console.log("\n❌ --apply against a non-localhost MongoDB requires --production. Nothing was changed."); process.exitCode = 2; return; }
  if (ROLLBACK) { await rollback(path.resolve(ROLLBACK)); return; }
  if (!CSV_PATH || !ICON_DIR) throw new Error("--csv and --icons are required");

  const rows = parseCsv(fs.readFileSync(CSV_PATH, "utf8")).map((r) => ({ id: r.id.trim(), name: r.name, file: r.file, expect: (r.expect_url || "").trim() || DEFAULT_ICON }));
  const docs = await SubCategory.find({ _id: { $in: rows.map((r) => r.id).filter((id) => /^[0-9a-f]{24}$/i.test(id)) } }).select("_id name iconUrl icon").lean();
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  const files = new Map();
  for (const r of rows) {
    const doc = byId.get(r.id);
    r.doc = doc;
    if (!doc) { r.status = "NOT_FOUND"; continue; }
    if (!files.has(r.file)) {
      const p = path.join(ICON_DIR, r.file);
      const buffer = fs.existsSync(p) ? fs.readFileSync(p) : null;
      const kind = buffer && detectKind(buffer);
      files.set(r.file, kind === "png" || kind === "jpeg" ? { buffer, mimetype: kind === "jpeg" ? "image/jpeg" : "image/png" } : null);
    }
    if (!files.get(r.file)) r.status = "BAD_FILE";
    else if (doc.iconUrl !== r.expect) r.status = "HAS_ICON";
    else r.status = "PENDING";
  }

  let backupFile = null;
  const pending = rows.filter((r) => r.status === "PENDING");
  if (APPLY && pending.length) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    backupFile = path.join(BACKUP_DIR, `assigned-subcategory-icons-${stamp()}.json`);
    const backup = { createdAt: new Date(), csv: CSV_PATH, assigned: [] };
    const assets = new Map();
    for (const r of pending) {
      try {
        if (!assets.has(r.file)) {
          const f = files.get(r.file);
          assets.set(r.file, (await images.uploadImage(f.buffer, { kind: "subcategory", filename: r.file, mimetype: f.mimetype, tags: [TAG] })).asset);
        }
        const asset = assets.get(r.file);
        const res = await SubCategory.updateOne({ _id: r.doc._id, iconUrl: r.expect }, { $set: { iconUrl: asset.url, icon: asset, updatedAt: new Date() } });
        if (res.modifiedCount === 1) {
          r.status = "ASSIGNED"; r.to = asset.url;
          backup.assigned.push({ _id: r.doc._id, name: r.doc.name, file: r.file, iconUrl: asset.url, sha256: asset.sha256, previousUrl: r.doc.iconUrl, previousIcon: r.doc.icon || null });
          fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2));
        } else r.status = "HAS_ICON";
      } catch (err) {
        r.status = "FAILED"; r.error = err.message;
      }
      process.stdout.write(`\r  ${backup.assigned.length}/${pending.length} assigned`);
    }
    process.stdout.write("\n");
  }

  for (const r of rows) if (r.status !== "PENDING" && r.status !== "ASSIGNED") console.log(`  ${r.status.padEnd(10)} ${r.name} (${r.id})${r.error ? ` – ${r.error}` : ""}`);
  const counts = rows.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});
  console.log(`\n${rows.length} rows, ${files.size} icon files: ${JSON.stringify(counts)}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const report = path.join(OUT_DIR, `assign-${APPLY ? "apply" : "dry-run"}-${stamp()}.csv`);
  fs.writeFileSync(report, ["id,name,file,status,icon_url,error"].concat(rows.map((r) => [r.id, r.doc ? r.doc.name : r.name, r.file, r.status, r.to, r.error].map(csvCell).join(","))).join("\n") + "\n");
  console.log(`Report: ${report}`);
  if (backupFile) console.log(`Backup (for --rollback): ${backupFile}`);
  if (!APPLY && pending.length) console.log(`\nDry run: ${pending.length} subcategories would get their icon. Re-run with --apply.`);
  if (rows.some((r) => r.status === "FAILED")) process.exitCode = 1;
}

main().catch((err) => { console.error(`\n❌ ${err.message}`); process.exitCode = 1; }).finally(() => mongoose.disconnect());
