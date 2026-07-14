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

async function createAllIndexes() {
  try {
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!mongoUri) {
      console.error("No MONGO_URI found in environment variables");
      process.exit(1);
    }

    await mongoose.connect(mongoUri);
    console.log("Connected to MongoDB for index creation...");

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

module.exports = { createAllIndexes };
