const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const Business = require('../models/Business');

async function cleanup() {
  try {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27014/business_listing');
    console.log('Connected to MongoDB');

    const businesses = await Business.find({ 'address.country': { $exists: true } });
    console.log(`Found ${businesses.length} businesses`);

    let updatedCount = 0;
    for (const biz of businesses) {
      const original = biz.address.country;
      const normalized = normalizeCountry(original);
      if (original !== normalized) {
        biz.address.country = normalized;
        await biz.save();
        updatedCount++;
        console.log(`Updated "${original}" to "${normalized}" for ${biz.businessName}`);
      }
    }

    console.log(`Cleanup complete. Updated ${updatedCount} businesses.`);
    process.exit(0);
  } catch (err) {
    console.error('Cleanup failed:', err);
    process.exit(1);
  }
}

function normalizeCountry(c) {
  if (!c) return "Unknown Country";
  const trimmed = c.trim();
  const upper = trimmed.toUpperCase();
  const map = {
    "USA": "United States",
    "US": "United States",
    "UNITED STATES": "United States",
    "UK": "United Kingdom",
    "U.K.": "United Kingdom",
    "UNITED KINGDOM": "United Kingdom",
    "UAE": "United Arab Emirates",
    "AU": "Australia",
    "AUSTRALIA": "Australia",
    "CA": "Canada",
    "CANADA": "Canada",
    "INDIA": "India"
  };
  return map[upper] || trimmed;
}

cleanup();
