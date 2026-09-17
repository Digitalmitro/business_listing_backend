#!/usr/bin/env node
"use strict";

/**
 * Normalizes `address.country` on Business documents so the admin panel's country
 * tabs and the public country filters match every listing.
 *
 *   node scripts/normalizeBusinessCountries.js            # dry run: report only
 *   node scripts/normalizeBusinessCountries.js --apply    # write the changes
 *
 * Three tiers, from safest to least:
 *   1. alias/ISO-code fixes ("IN" -> "India", "usa" -> "United States")
 *   2. inference for values that are clearly a state/city/postcode rather than a
 *      country ("West Bengal 700029" -> India, "AL 36067" -> United States)
 *   3. everything else is left untouched and listed for manual review
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const mongoose = require("mongoose");
const Business = require("../models/Business");
const { normalizeCountry, isKnownCountry } = require("../helpers/country");

const APPLY = process.argv.includes("--apply");

const INDIAN_STATES = [
  "andhra pradesh", "arunachal pradesh", "assam", "bihar", "chhattisgarh", "goa", "gujarat", "haryana",
  "himachal pradesh", "jharkhand", "karnataka", "kerala", "madhya pradesh", "maharashtra", "manipur",
  "meghalaya", "mizoram", "nagaland", "odisha", "punjab", "rajasthan", "sikkim", "tamil nadu", "telangana",
  "tripura", "uttar pradesh", "uttarakhand", "west bengal", "delhi", "new delhi", "jammu and kashmir",
  "ladakh", "puducherry", "chandigarh", "andaman and nicobar islands",
];
const INDIAN_CITIES = [
  "kolkata", "calcutta", "howrah", "newtown", "new town", "bidhannagar", "salt lake", "dum dum", "south dumdum",
  "north dumdum", "rajarhat", "mumbai", "bengaluru", "bangalore", "chennai", "hyderabad", "pune", "ahmedabad",
  "jaipur", "kochi", "visakhapatnam", "gurugram", "gurgaon", "noida", "coimbatore", "serampore", "madhyamgram",
  "behala", "garia", "baranagar", "belghoria", "khardaha", "rahara", "kalighat", "gariahat", "tollygunge",
  "ballygunge", "bhowanipore", "dhakuria", "kankurgachi", "lake town", "baguiati", "baguihati", "kestopur",
  "tiljala", "anandapur", "mukundapur", "thakurpukur", "nagerbazar", "shyam bazar", "shobhabazar", "bowbazar",
  "entally", "taltala", "beniapukur", "kolaghat", "bankura", "worli", "kandivali", "marathahalli", "hsr layout",
  "yeswanthpur", "guttahalli", "chinchwad gaon", "b.b.d. bagh", "new alipore", "jadavpur", "santoshpur",
];
const US_STATE_ABBR = /^(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\s+\d{5}(-\d{4})?$/i;

function inferCountry(value, doc) {
  const v = String(value || "").trim().toLowerCase();
  if (!v) return null;
  if (US_STATE_ABBR.test(v)) return "United States";
  if (/\b\d{6}\b/.test(v) && INDIAN_STATES.some((s) => v.startsWith(s))) return "India";
  if (INDIAN_STATES.some((s) => v === s || v.startsWith(s + " "))) return "India";
  if (INDIAN_CITIES.includes(v)) return "India";
  // Fall back to the rest of the address when it is unambiguous.
  const state = String(doc.address?.state || "").trim().toLowerCase();
  const pincode = String(doc.address?.pincode || "").trim();
  if (INDIAN_STATES.includes(state) && /^\d{6}$/.test(pincode)) return "India";
  if (/^[A-Z]{2}$/i.test(state) && /^\d{5}(-\d{4})?$/.test(pincode) && !["in"].includes(state)) return "United States";
  return null;
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Connected to ${mongoose.connection.host}/${mongoose.connection.name} (${APPLY ? "APPLY" : "DRY RUN"})`);

  const groups = await Business.aggregate([
    { $group: { _id: "$address.country", n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ]);

  const aliasFixes = [];   // { from, to, n }
  const inferFixes = [];   // { from, to, n }
  const unresolved = [];   // { from, n }

  for (const g of groups) {
    const from = g._id;
    if (from == null) { unresolved.push({ from: null, n: g.n }); continue; }
    const normalized = normalizeCountry(from);
    if (isKnownCountry(from)) {
      if (normalized !== from) aliasFixes.push({ from, to: normalized, n: g.n });
      continue;
    }
    if (from === "Unknown Country") continue;
    const sample = await Business.findOne({ "address.country": from }).select("address").lean();
    const inferred = inferCountry(from, sample || {});
    if (inferred) inferFixes.push({ from, to: inferred, n: g.n });
    else unresolved.push({ from, n: g.n });
  }

  const print = (title, rows) => {
    console.log(`\n${title} (${rows.length} distinct values, ${rows.reduce((a, r) => a + r.n, 0)} businesses)`);
    for (const r of rows.slice(0, 60)) console.log(`  ${JSON.stringify(r.from)} -> ${JSON.stringify(r.to ?? "(unchanged)")}  x${r.n}`);
    if (rows.length > 60) console.log(`  ... ${rows.length - 60} more`);
  };
  print("Tier 1: alias / ISO-code fixes", aliasFixes);
  print("Tier 2: inferred from state/city/postcode", inferFixes);
  print("Tier 3: left for manual review", unresolved);

  if (!APPLY) { console.log("\nDry run only. Re-run with --apply to write tiers 1 and 2."); await mongoose.disconnect(); return; }

  let updated = 0;
  for (const fix of [...aliasFixes, ...inferFixes]) {
    const res = await Business.updateMany({ "address.country": fix.from }, { $set: { "address.country": fix.to } });
    updated += res.modifiedCount;
  }
  console.log(`\nUpdated ${updated} businesses.`);
  await mongoose.disconnect();
})().catch((err) => { console.error(err); process.exit(1); });
