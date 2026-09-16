// backend/scripts/createIndexes.js
"use strict";

const mongoose = require("mongoose");
const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const { CrmLead } = require("../models/CrmLead");
const CrmContact = require("../models/CrmContact");
const CrmEvent = require("../models/CrmEvent");
const { CrmAuditLog } = require("../models/CrmAuditLog");
const CrmFollowUpConfig = require("../models/CrmFollowUpConfig");
const CrmLeadFollowUpLog = require("../models/CrmLeadFollowUpLog");
const CrmEmailReplyLog = require("../models/CrmEmailReplyLog");
const {
  CrmPipelineStage,
  CrmEventType,
  CrmReplyKeyword,
  CrmSchedulerConfig,
} = require("../models/CrmConfig");
const ScheduledSocialPost = require("../models/ScheduledSocialPost");
const UnsubscribedEmail = require("../models/UnsubscribedEmail");
const Business = require("../models/Business");

async function ensureBusinessGoogleLocationIndex() {
  const duplicates = await Business.aggregate([
    { $match: { googleLocationId: { $type: "string", $ne: "" } } },
    { $group: { _id: "$googleLocationId", count: { $sum: 1 }, businessIds: { $push: "$_id" } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 20 },
  ]);
  if (duplicates.length > 0) {
    const ids = duplicates.map((row) => row._id).join(", ");
    throw new Error(`Cannot create the unique Google location index; duplicate googleLocationId values must be reviewed first: ${ids}`);
  }

  const indexName = "googleLocationId_1";
  const desiredPartialFilter = { googleLocationId: { $type: "string", $gt: "" } };
  const indexes = await Business.collection.indexes();
  const current = indexes.find((index) => index.name === indexName);
  if (current && (!current.unique || JSON.stringify(current.partialFilterExpression) !== JSON.stringify(desiredPartialFilter))) {
    await Business.collection.dropIndex(indexName);
  }
  await Business.collection.createIndex(
    { googleLocationId: 1 },
    { name: indexName, unique: true, partialFilterExpression: desiredPartialFilter }
  );
}

async function createAllIndexes() {
  try {
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!mongoUri) {
      console.error("No MONGO_URI found in environment variables");
      process.exit(1);
    }

    await mongoose.connect(mongoUri);
    console.log("Connected to MongoDB for index creation...");

    // This deliberately refuses to guess which existing Business should keep a
    // duplicated Google location link. Resolve any reported rows first, then
    // rerun the script; no Business document is deleted or rewritten here.
    await ensureBusinessGoogleLocationIndex();
    console.log("Successfully created/verified unique Google location index for Business");

    const models = [
      { name: "CrmLead", model: CrmLead },
      { name: "CrmContact", model: CrmContact },
      { name: "CrmEvent", model: CrmEvent },
      { name: "CrmAuditLog", model: CrmAuditLog },
      { name: "CrmFollowUpConfig", model: CrmFollowUpConfig },
      { name: "CrmLeadFollowUpLog", model: CrmLeadFollowUpLog },
      { name: "CrmEmailReplyLog", model: CrmEmailReplyLog },
      { name: "CrmPipelineStage", model: CrmPipelineStage },
      { name: "CrmEventType", model: CrmEventType },
      { name: "CrmReplyKeyword", model: CrmReplyKeyword },
      { name: "CrmSchedulerConfig", model: CrmSchedulerConfig },
      { name: "ScheduledSocialPost", model: ScheduledSocialPost },
      { name: "UnsubscribedEmail", model: UnsubscribedEmail },
      { name: "Business", model: Business },
    ];

    for (const { name, model } of models) {
      try {
        await model.createIndexes();
        console.log(`Successfully created/verified indexes for collection: ${name}`);
      } catch (idxErr) {
        console.error(`Error building indexes for ${name}:`, idxErr.message);
      }
    }

    console.log("All database index checks completed.");
    process.exit(0);
  } catch (err) {
    console.error("Database connection failed during createIndexes script:", err);
    process.exit(1);
  }
}

if (require.main === module) {
  createAllIndexes();
}

module.exports = { createAllIndexes, ensureBusinessGoogleLocationIndex };
