#!/usr/bin/env node
"use strict";

/**
 * Moves an existing database from the old packages (Silver/Gold/Platinum/Diamond)
 * to Basic / Silver / Gold / Premium.
 *
 *   node scripts/migratePricingPlans.js            # dry run: prints what would change
 *   node scripts/migratePricingPlans.js --apply    # writes
 *
 * Business subscriptions are mapped by rank:
 *   Silver (old free tier) -> Free     Gold ($100)  -> Basic
 *   Platinum               -> Gold     Diamond      -> Premium
 * Businesses whose package is already a new name are left alone. Packages are
 * then replaced with the new definitions (seed/pricingPlans.data.js) and each
 * business's subscription.packageId is re-pointed at the new package.
 *
 * Prices of the new packages are USD only (INR/GBP 0) until set in Admin → Packages.
 * A JSON backup of every changed business subscription and every old package is
 * written to scripts/backups/ before anything is changed.
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");
const Business = require("../models/Business");
const PricingPackage = require("../models/PricingPackage");
const { buildPackages } = require("../seed/pricingPlans.data");

const APPLY = process.argv.includes("--apply");
const OLD_TO_NEW = { Silver: "Free", Gold: "Basic", Platinum: "Gold", Diamond: "Premium" };

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const oldPackages = await PricingPackage.find({}).lean();
  const isOldCatalog = oldPackages.some((p) => ["Platinum", "Diamond"].includes(p.name));
  const businesses = await Business.find({ "subscription.packageName": { $in: Object.keys(OLD_TO_NEW) } })
    .select("_id businessName subscription")
    .lean();

  // Only remap Silver/Gold if the catalog is still the old one (otherwise they are new names).
  const toChange = businesses.filter((b) => isOldCatalog || ["Platinum", "Diamond"].includes(b.subscription.packageName));
  const counts = {};
  for (const b of toChange) {
    const key = `${b.subscription.packageName} -> ${OLD_TO_NEW[b.subscription.packageName]} (${b.subscription.status})`;
    counts[key] = (counts[key] || 0) + 1;
  }

  console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN"}`);
  console.log(`Packages now: ${oldPackages.map((p) => `${p.name}${p.isActive ? "" : " (inactive)"}`).join(", ") || "none"}`);
  console.log(`Old catalog detected: ${isOldCatalog}`);
  console.log(`Business subscriptions to remap: ${toChange.length}`);
  for (const [k, n] of Object.entries(counts)) console.log(`  ${k}: ${n}`);
  console.log(`New packages: ${buildPackages().map((p) => `${p.name} $${p.priceUSD}/mo`).join(", ")}`);

  if (!APPLY) {
    console.log("\nDry run only. Re-run with --apply to write.");
    return;
  }

  const backupDir = path.join(__dirname, "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const backupFile = path.join(backupDir, `pricing-plans-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(backupFile, JSON.stringify({ packages: oldPackages, subscriptions: toChange.map((b) => ({ _id: b._id, subscription: b.subscription })) }, null, 1));
  console.log(`Backup written: ${backupFile}`);

  for (const b of toChange) {
    const next = OLD_TO_NEW[b.subscription.packageName];
    const set = next === "Free"
      ? { "subscription.packageName": "Free", "subscription.packageId": null, "subscription.status": "inactive" }
      : { "subscription.packageName": next };
    await Business.updateOne({ _id: b._id }, { $set: set });
  }

  await PricingPackage.deleteMany({});
  const created = await PricingPackage.insertMany(buildPackages());
  const idByName = Object.fromEntries(created.map((p) => [p.name, p._id]));
  for (const [name, id] of Object.entries(idByName)) {
    await Business.updateMany({ "subscription.packageName": name }, { $set: { "subscription.packageId": id } });
  }
  console.log(`Done: ${toChange.length} subscriptions remapped, ${created.length} packages created.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
