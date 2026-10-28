/**
 * Put listed subcategories back on the default placeholder icon.
 *
 *   node scripts/clearSubcategoryIcons.js --slugs <file> --keep-shas <file>             dry run
 *   node scripts/clearSubcategoryIcons.js --slugs <file> --keep-shas <file> --apply --production
 *   node scripts/clearSubcategoryIcons.js --rollback scripts/backups/cleared-subcategory-icons-<stamp>.json [--apply --production]
 *
 *   --slugs <file>      one subcategory slug per line
 *   --keep-shas <file>  one sha256 per line; a subcategory whose icon has one of these is never cleared
 *   --out <dir>         report directory (default ./reports next to the slugs file)
 *
 * Safety: the backup (scripts/backups/) stores each document's previous iconUrl + icon before it is
 * changed; --rollback restores exactly those, if the document still shows the default icon.
 * Cloudinary images are left in place (invisible on the site), so --rollback fully restores.
 */
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const mongoose = require("mongoose");
const SubCategory = require("../models/SubCategory");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => { const i = argv.indexOf(name); return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : fallback; };

const APPLY = flag("--apply");
const PRODUCTION = flag("--production");
const ROLLBACK = opt("--rollback", null);
const SLUGS_PATH = opt("--slugs", null) && path.resolve(opt("--slugs"));
const KEEP_PATH = opt("--keep-shas", null) && path.resolve(opt("--keep-shas"));
const MONGO_URI = opt("--mongo-uri", process.env.MONGO_URI);
const OUT_DIR = path.resolve(opt("--out", SLUGS_PATH ? path.join(path.dirname(SLUGS_PATH), "reports") : "reports"));
const BACKUP_DIR = path.join(__dirname, "backups");
const DEFAULT_ICON = SubCategory.schema.path("iconUrl").defaultValue;

const isLocalMongo = (uri) => /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(String(uri || ""));
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const lines = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const csvCell = (v) => { const s = v === undefined || v === null ? "" : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

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
  console.log(`Rollback of ${backup.cleared.length} subcategories from ${file}${APPLY ? "" : " (dry run)"}`);
  let restored = 0;
  for (const entry of backup.cleared) {
    const doc = await SubCategory.findById(entry._id).select("name iconUrl").lean();
    if (!doc) { console.log(`  - ${entry.name}: document gone`); continue; }
    if (doc.iconUrl !== DEFAULT_ICON) { console.log(`  ! ${entry.name}: icon changed since clearing; kept`); continue; }
    if (APPLY) await SubCategory.updateOne({ _id: entry._id }, { $set: { iconUrl: entry.iconUrl, icon: entry.icon, updatedAt: new Date() } });
    console.log(`  ✓ ${entry.name} → ${entry.iconUrl}`);
    restored++;
  }
  console.log(`${APPLY ? "Restored" : "Would restore"} ${restored}.`);
}

async function main() {
  if (!MONGO_URI) throw new Error("MONGO_URI is required (or pass --mongo-uri)");
  await connect();
  const local = isLocalMongo(MONGO_URI);
  console.log(`MongoDB: ${mongoose.connection.host}/${mongoose.connection.name} (${local ? "localhost" : "REMOTE"})  Mode: ${APPLY ? "APPLY" : "DRY RUN"}`);
  if (APPLY && !local && !PRODUCTION) { console.log("\n❌ --apply against a non-localhost MongoDB requires --production. Nothing was changed."); process.exitCode = 2; return; }
  if (ROLLBACK) { await rollback(path.resolve(ROLLBACK)); return; }
  if (!SLUGS_PATH || !KEEP_PATH) throw new Error("--slugs and --keep-shas are required");

  const slugs = lines(SLUGS_PATH);
  const keep = new Set(lines(KEEP_PATH));
  // A line may be a slug or a 24-hex document id; slugs are not reliably unique in the live data.
  const isId = (s) => /^[0-9a-f]{24}$/i.test(s);
  const docs = await SubCategory.find({ $or: [{ slug: { $in: slugs } }, { _id: { $in: slugs.filter(isId) } }] }).select("_id name slug iconUrl icon").lean();
  const rows = slugs.map((slug) => {
    const matches = docs.filter((d) => (isId(slug) ? String(d._id) === slug : d.slug === slug));
    if (!matches.length) return { slug, status: "NOT_FOUND" };
    if (matches.length > 1) return { slug, name: matches.map((d) => `${d.name} (${d._id})`).join(" | "), status: "AMBIGUOUS_SLUG" };
    const doc = matches[0];
    const row = { slug, name: doc.name, doc, from: doc.iconUrl };
    if (doc.iconUrl === DEFAULT_ICON) row.status = "ALREADY_DEFAULT";
    else if (doc.icon && keep.has(doc.icon.sha256)) row.status = "KEPT_ORIGINAL";
    else row.status = "PENDING";
    return row;
  });

  const pending = rows.filter((r) => r.status === "PENDING");
  let backupFile = null;
  if (APPLY && pending.length) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    backupFile = path.join(BACKUP_DIR, `cleared-subcategory-icons-${stamp()}.json`);
    fs.writeFileSync(backupFile, JSON.stringify({ createdAt: new Date(), cleared: pending.map((r) => ({ _id: r.doc._id, name: r.name, slug: r.slug, iconUrl: r.doc.iconUrl, icon: r.doc.icon })) }, null, 2));
    for (const r of pending) {
      await SubCategory.updateOne({ _id: r.doc._id, iconUrl: r.doc.iconUrl }, { $set: { iconUrl: DEFAULT_ICON, updatedAt: new Date() }, $unset: { icon: "" } });
      r.status = "CLEARED";
    }
  }

  const counts = rows.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});
  for (const r of rows) console.log(`  ${r.status.padEnd(15)} ${r.name || r.slug}`);
  console.log(`\n${JSON.stringify(counts)}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const report = path.join(OUT_DIR, `${APPLY ? "apply" : "dry-run"}-${stamp()}.csv`);
  fs.writeFileSync(report, ["slug,name,status,previous_icon"].concat(rows.map((r) => [r.slug, r.name, r.status, r.from].map(csvCell).join(","))).join("\n") + "\n");
  console.log(`Report: ${report}`);
  if (backupFile) console.log(`Backup (for --rollback): ${backupFile}`);
  if (!APPLY && pending.length) console.log(`\nDry run: ${pending.length} would go back to the default icon. Re-run with --apply.`);
}

main().catch((err) => { console.error(`\n❌ ${err.message}`); process.exitCode = 1; }).finally(() => mongoose.disconnect());
