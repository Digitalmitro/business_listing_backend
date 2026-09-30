#!/usr/bin/env node
"use strict";

/**
 * Puts the four homepage top-banner cards back to the original 2024 design:
 * coloured cards with a title, a subtitle and a cut-out image.
 *
 *   node scripts/restoreHomepageCards.js                    # dry run: report only
 *   node scripts/restoreHomepageCards.js --apply            # write the changes
 *   node scripts/restoreHomepageCards.js --restore <file>   # put a backup back
 *
 * The images must already be on the server that serves /uploads (IMAGE_BASE_URL,
 * default https://server.urbancitations.com/uploads). --apply refuses to run while
 * any of them is unreachable, so the live cards never point at a missing file.
 * Copy them first from recovered-uploads/homepage-cards/ (see README there).
 *
 * The four existing records are updated in place (same ids). Before writing, their
 * current values are saved to scripts/backups/ so --restore can undo the change.
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const mongoose = require("mongoose");
const TopBannerCategory = require("../models/TopBannerCategory");
const Category = require("../models/Category");

const APPLY = process.argv.includes("--apply");
const RESTORE_INDEX = process.argv.indexOf("--restore");
const IMAGE_BASE_URL = (process.env.IMAGE_BASE_URL || "https://server.urbancitations.com/uploads").replace(/\/+$/, "");
const BACKUP_DIR = path.join(__dirname, "backups");
const FIELDS = ["title", "paragraph", "bgColor", "imageUrl", "priority", "categoryId"];

// Record id -> card. Higher priority shows first on the homepage.
// category: matched against Category.name; when nothing matches the record keeps its current category.
const CARDS = [
  { id: "69713057c9cdc16f56ae830b", title: "Plumber", paragraph: "Contact Us", bgColor: "#0076D7", file: "homepage-card-plumber.png", priority: 40, category: /^home services$/i },
  { id: "69713049c9cdc16f56ae82ff", title: "Carpenter", paragraph: "Visit Us", bgColor: "#D1775B", file: "homepage-card-carpenter.png", priority: 30, category: /^home services$/i },
  { id: "6966897dbe4ac703781d7044", title: "Dentist", paragraph: "Book Us", bgColor: "#40C9B0", file: "homepage-card-dentist.png", priority: 20, category: /health|medical|doctor|dental/i },
  { id: "69713061c9cdc16f56ae8311", title: "Beauty Spa", paragraph: "Visit Us", bgColor: "#FFC179", file: "homepage-card-beauty-spa.png", priority: 10, category: /beauty/i },
];

async function checkImage(url) {
  try {
    const res = await fetch(url, { method: "HEAD" });
    const type = res.headers.get("content-type") || "";
    return res.ok && type.startsWith("image/") ? null : `HTTP ${res.status} ${type}`.trim();
  } catch (error) {
    return error.message;
  }
}

async function restore(file) {
  const backup = JSON.parse(fs.readFileSync(file, "utf8"));
  console.log(`Restoring ${backup.length} record(s) from ${file} (${APPLY ? "APPLY" : "DRY RUN"})`);
  for (const rec of backup) {
    const set = {};
    const unset = {};
    for (const f of FIELDS) {
      if (rec[f] === undefined || rec[f] === null) unset[f] = "";
      else set[f] = f === "categoryId" ? new mongoose.Types.ObjectId(rec[f]) : rec[f];
    }
    console.log(`  ${rec._id}: ${JSON.stringify(set)}${Object.keys(unset).length ? ` unset ${Object.keys(unset).join(",")}` : ""}`);
    if (APPLY) {
      await TopBannerCategory.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(rec._id) },
        { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) }
      );
    }
  }
  if (!APPLY) console.log("\nDry run only. Re-run with --apply to write these changes.");
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Connected to ${mongoose.connection.host}/${mongoose.connection.name} (${APPLY ? "APPLY" : "DRY RUN"})`);

  if (RESTORE_INDEX !== -1) {
    await restore(process.argv[RESTORE_INDEX + 1]);
    return;
  }

  const categories = await Category.find({}, { name: 1, slug: 1 }).lean();
  const plan = [];
  let problems = 0;

  for (const card of CARDS) {
    const current = await TopBannerCategory.findById(card.id).lean();
    if (!current) {
      console.log(`\n✗ ${card.title}: record ${card.id} not found`);
      problems++;
      continue;
    }
    const category = categories.find((c) => card.category.test(c.name));
    const imageUrl = `${IMAGE_BASE_URL}/${card.file}`;
    const imageProblem = await checkImage(imageUrl);
    if (imageProblem) problems++;

    const update = {
      title: card.title,
      paragraph: card.paragraph,
      bgColor: card.bgColor,
      imageUrl,
      priority: card.priority,
      categoryId: category ? category._id : current.categoryId,
    };
    plan.push({ current, update });

    const currentCategory = categories.find((c) => String(c._id) === String(current.categoryId));
    console.log(`\n${card.title}  (record ${card.id})`);
    console.log(`  image    ${current.imageUrl}\n        -> ${imageUrl}  ${imageProblem ? `✗ NOT REACHABLE (${imageProblem})` : "✓ reachable"}`);
    console.log(`  title    ${current.title ?? "(none)"} -> ${card.title} / ${card.paragraph}, colour ${card.bgColor}, priority ${card.priority}`);
    console.log(`  category ${currentCategory?.name ?? current.categoryId} -> ${category ? category.name : "(no match, unchanged)"}`);
  }

  if (!APPLY) {
    console.log(`\nDry run only.${problems ? ` Fix the ${problems} problem(s) above first, then` : ""} Re-run with --apply to write these changes.`);
    return;
  }
  if (problems) {
    console.log(`\nNot applied: ${problems} problem(s) above. Nothing was changed.`);
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const backupFile = path.join(BACKUP_DIR, `homepage-cards-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(
    backupFile,
    JSON.stringify(plan.map(({ current }) => ({ _id: current._id, ...Object.fromEntries(FIELDS.map((f) => [f, current[f] ?? null])) })), null, 2)
  );
  console.log(`\nBackup of the current values: ${backupFile}`);

  for (const { current, update } of plan) {
    await TopBannerCategory.updateOne({ _id: current._id }, { $set: update });
  }
  console.log(`Updated ${plan.length} card(s). Undo with: node scripts/restoreHomepageCards.js --restore ${path.relative(process.cwd(), backupFile)} --apply`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
