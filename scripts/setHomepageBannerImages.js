#!/usr/bin/env node
/**
 * Put the original homepage banner images back (carousel, top-banner cards, popular-search tall banners),
 * storing them in Cloudinary so a server deploy can no longer wipe them (2026-10-24).
 *
 *   node scripts/setHomepageBannerImages.js --csv <file> --images <dir>                         dry run (default)
 *   node scripts/setHomepageBannerImages.js --csv <file> --images <dir> --apply --production    write against a non-localhost MongoDB
 *   node scripts/setHomepageBannerImages.js --rollback scripts/backups/homepage-banner-images-<stamp>.json [--apply --production]
 *
 *   --csv <file>        columns: model (Banner | TopBannerCategory | PopularSearch), id, title, file, expect_url
 *   --images <dir>      folder holding each `file`
 *   --mongo-uri <uri>   MongoDB                (default MONGO_URI from .env)
 *   --root <folder>     Cloudinary root folder (default CLOUDINARY_ROOT_FOLDER or "urbancitations")
 *   --out <dir>         report directory       (default ./reports next to the CSV)
 *
 * Safety: a record is only changed while its imageUrl still equals `expect_url` (the stand-in seen when
 * the CSV was built), so an image an admin uploaded in the meantime is never overwritten. Only imageUrl
 * changes. The backup keeps each previous imageUrl; --rollback restores it if the record still shows
 * the image this script set. Cloudinary images are left in place.
 */
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const mongoose = require("mongoose");
const { detectKind } = require("../utils/uploadValidation");
const images = require("../services/imageStorageService");

const MODELS = {
  Banner: { model: require("../models/Banner"), kind: "banner" },
  TopBannerCategory: { model: require("../models/TopBannerCategory"), kind: "topBannerCategory" },
  PopularSearch: { model: require("../models/PopularSearch"), kind: "popularSearch" },
};

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => { const i = argv.indexOf(name); return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : fallback; };

const APPLY = flag("--apply");
const PRODUCTION = flag("--production");
const ROLLBACK = opt("--rollback", null);
const CSV_PATH = opt("--csv", null) && path.resolve(opt("--csv"));
const IMAGE_DIR = opt("--images", null) && path.resolve(opt("--images"));
const MONGO_URI = opt("--mongo-uri", process.env.MONGO_URI);
const OUT_DIR = path.resolve(opt("--out", CSV_PATH ? path.join(path.dirname(CSV_PATH), "reports") : "reports"));
const BACKUP_DIR = path.join(__dirname, "backups");
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
  console.log(`Rollback of ${backup.changed.length} records from ${file}${APPLY ? "" : " (dry run)"}`);
  let restored = 0;
  for (const entry of backup.changed) {
    const { model } = MODELS[entry.model];
    const doc = await model.findById(entry._id).select("imageUrl").lean();
    if (!doc) { console.log(`  - ${entry.model} ${entry.title}: record gone`); continue; }
    if (doc.imageUrl !== entry.imageUrl) { console.log(`  ! ${entry.model} ${entry.title}: image changed since; kept`); continue; }
    if (APPLY) await model.updateOne({ _id: entry._id, imageUrl: entry.imageUrl }, { $set: { imageUrl: entry.previousUrl } });
    console.log(`  ✓ ${entry.model} ${entry.title} → ${entry.previousUrl}`);
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
  if (!CSV_PATH || !IMAGE_DIR) throw new Error("--csv and --images are required");

  const rows = parseCsv(fs.readFileSync(CSV_PATH, "utf8"));
  for (const r of rows) {
    const spec = MODELS[r.model];
    if (!spec) { r.status = "BAD_MODEL"; continue; }
    const p = path.join(IMAGE_DIR, r.file);
    r.buffer = fs.existsSync(p) ? fs.readFileSync(p) : null;
    const kind = r.buffer && detectKind(r.buffer);
    if (kind !== "jpeg" && kind !== "png" && kind !== "webp") { r.status = "BAD_FILE"; continue; }
    r.mimetype = `image/${kind}`;
    const doc = await spec.model.findById(r.id).select("imageUrl").lean();
    if (!doc) { r.status = "NOT_FOUND"; continue; }
    r.current = doc.imageUrl;
    r.status = doc.imageUrl === r.expect_url ? "PENDING" : "CHANGED";
  }

  const blocked = rows.filter((r) => r.status !== "PENDING");
  let backupFile = null;
  if (APPLY && blocked.length) {
    console.log("\n❌ Some rows are not ready (see below); nothing was changed.");
    process.exitCode = 2;
  } else if (APPLY) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    backupFile = path.join(BACKUP_DIR, `homepage-banner-images-${stamp()}.json`);
    const backup = { createdAt: new Date(), csv: CSV_PATH, changed: [] };
    for (const r of rows) {
      try {
        const { asset } = await images.uploadImage(r.buffer, { kind: MODELS[r.model].kind, filename: r.file, mimetype: r.mimetype, tags: ["homepage-original-2026-10-24"] });
        const res = await MODELS[r.model].model.updateOne({ _id: r.id, imageUrl: r.expect_url }, { $set: { imageUrl: asset.url } });
        if (res.modifiedCount === 1) {
          r.status = "SET"; r.to = asset.url;
          backup.changed.push({ model: r.model, _id: r.id, title: r.title, previousUrl: r.expect_url, imageUrl: asset.url, asset });
          fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2));
        } else r.status = "CHANGED";
      } catch (err) {
        r.status = "FAILED"; r.error = err.message;
      }
    }
  }

  for (const r of rows) console.log(`  ${r.status.padEnd(9)} ${r.model.padEnd(18)} ${r.title.padEnd(32)} ${r.file}${r.status === "CHANGED" ? `  (now ${r.current})` : ""}${r.error ? ` – ${r.error}` : ""}`);
  const counts = rows.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});
  console.log(`\n${JSON.stringify(counts)}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const report = path.join(OUT_DIR, `${APPLY ? "apply" : "dry-run"}-${stamp()}.csv`);
  fs.writeFileSync(report, ["model,id,title,file,status,previous_url,new_url,error"].concat(rows.map((r) => [r.model, r.id, r.title, r.file, r.status, r.current, r.to, r.error].map(csvCell).join(","))).join("\n") + "\n");
  console.log(`Report: ${report}`);
  if (backupFile) console.log(`Backup (for --rollback): ${backupFile}`);
  if (!APPLY && !blocked.length) console.log(`\nDry run: all ${rows.length} images ready. Re-run with --apply.`);
  if (rows.some((r) => r.status === "FAILED")) process.exitCode = 1;
}

main().catch((err) => { console.error(`\n❌ ${err.message}`); process.exitCode = 1; }).finally(() => mongoose.disconnect());
