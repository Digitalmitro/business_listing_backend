#!/usr/bin/env node
/**
 * Marks owner listings that are linked to a Google Business Profile location as claimed.
 * Before 2026-11-02, linking or syncing a listing with Google never set `claimed`, so owners
 * who connected Google still saw "Unclaimed". New links are claimed by syncLinkedBusiness;
 * this one-off backfill fixes listings linked before that deploy.
 *
 *   node scripts/claimGoogleLinkedListings.js            dry run (default): lists what would change
 *   node scripts/claimGoogleLinkedListings.js --apply    sets claimed: true on those listings
 *
 * Only listings that have an owner (userId) and a Google location (googleLocationId) and are
 * still unclaimed are touched; the same conditions are repeated in the update filter.
 */
"use strict";

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const mongoose = require("mongoose");

const apply = process.argv.includes("--apply");
const filter = {
  userId: { $ne: null },
  googleLocationId: { $type: "string", $gt: "" },
  claimed: { $ne: true },
};

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const businesses = mongoose.connection.db.collection("businesses");
  const targets = await businesses
    .find(filter, { projection: { businessName: 1, userId: 1, googleLocationId: 1 } })
    .toArray();

  console.log(`${targets.length} Google-linked owner listing(s) still unclaimed:`);
  for (const b of targets) console.log(`  ${b._id}  ${b.businessName}  (${b.googleLocationId})`);

  if (!apply) {
    console.log("\nDry run: nothing changed. Re-run with --apply to mark them claimed.");
  } else if (targets.length) {
    const result = await businesses.updateMany(
      { ...filter, _id: { $in: targets.map((b) => b._id) } },
      { $set: { claimed: true, updatedAt: new Date() } }
    );
    console.log(`\nUpdated ${result.modifiedCount} listing(s): claimed = true`);
  }
  await mongoose.disconnect();
})().catch(async (error) => {
  console.error(error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
