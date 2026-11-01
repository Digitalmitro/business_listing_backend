// backend/scripts/seedCrmConfig.js
"use strict";

const mongoose = require("mongoose");
const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const {
  CrmPipelineStage,
  CrmEventType,
  CrmReplyKeyword,
  CrmSchedulerConfig,
} = require("../models/CrmConfig");
const { getDefaultStages } = require("../controllers/crmConfigController");

// Shapes follow models/CrmConfig.js (CrmPipelineStage needs `internalKey`, probability is
// a 0–1 fraction, ordering is `sortOrder`). Stages are the API's own defaults
// (controllers/crmConfigController.js), including "Booked", as system-wide rows (ownerId null).
const defaultPipelineStages = getDefaultStages().map((stage) => ({
  ...stage,
  isActive: true,
  ownerId: null,
}));

// Same names the calendar falls back to (crmScheduleService validates event types by name).
const defaultEventTypes = [
  { name: "Follow-up", color: "#3b82f6", icon: "CalendarOutlined", sortOrder: 1, isActive: true },
  { name: "Meeting", color: "#10b981", icon: "TeamOutlined", sortOrder: 2, isActive: true },
  { name: "Call", color: "#f59e0b", icon: "PhoneOutlined", sortOrder: 3, isActive: true },
  { name: "Demo", color: "#8b5cf6", icon: "DesktopOutlined", sortOrder: 4, isActive: true },
  { name: "Proposal reminder", color: "#ef4444", icon: "FileTextOutlined", sortOrder: 5, isActive: true },
  { name: "Other", color: "#64748b", icon: "PushpinOutlined", sortOrder: 6, isActive: true },
];

// classification is "Positive" | "Negative" | "Unknown"; negatives get the higher priority so
// "not interested" wins over "interested".
const negativeKeywords = ["not interested", "unsubscribe", "stop", "remove me", "don't contact", "do not contact", "spam", "take me off", "no thanks", "no thank you", "too expensive", "not a good fit"];
const positiveKeywords = ["interested", "more info", "tell me more", "schedule a call", "let's talk", "lets talk", "send details", "send more info", "what are the next steps", "how much", "pricing", "available", "when can we connect"];
const defaultReplyKeywords = [
  ...negativeKeywords.map((keyword) => ({ keyword, classification: "Negative", priority: 10, isActive: true })),
  ...positiveKeywords.map((keyword) => ({ keyword, classification: "Positive", priority: 5, isActive: true })),
];

const defaultSchedulerConfig = {
  key: "global",
  isEnabled: true,
  defaultIntervalDays: Number(process.env.CRM_FOLLOWUP_DAYS_DEFAULT || 3),
  schedulerIntervalMs: Number(process.env.CRM_CRON_INTERVAL_MINUTES || 60) * 60 * 1000,
};

async function seedCrmConfig() {
  try {
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!mongoUri) {
      console.error("No MONGO_URI found in environment variables");
      process.exit(1);
    }

    await mongoose.connect(mongoUri);
    console.log("Connected to MongoDB...");

    // 1. Pipeline stages
    const existingStages = await CrmPipelineStage.countDocuments();
    if (existingStages === 0) {
      await CrmPipelineStage.insertMany(defaultPipelineStages);
      console.log(`Seeded ${defaultPipelineStages.length} CRM pipeline stages.`);
    } else {
      console.log(`CrmPipelineStage collection already has ${existingStages} entries. Skipping stages.`);
    }

    // 2. Event types
    const existingEvents = await CrmEventType.countDocuments();
    if (existingEvents === 0) {
      await CrmEventType.insertMany(defaultEventTypes);
      console.log(`Seeded ${defaultEventTypes.length} CRM event types.`);
    } else {
      console.log(`CrmEventType collection already has ${existingEvents} entries. Skipping events.`);
    }

    // 3. Reply keywords
    const existingKeywords = await CrmReplyKeyword.countDocuments();
    if (existingKeywords === 0) {
      await CrmReplyKeyword.insertMany(defaultReplyKeywords);
      console.log(`Seeded ${defaultReplyKeywords.length} CRM reply keywords.`);
    } else {
      console.log(`CrmReplyKeyword collection already has ${existingKeywords} entries. Skipping keywords.`);
    }

    // 4. Scheduler config
    const existingScheduler = await CrmSchedulerConfig.findOne({ key: "global" });
    if (!existingScheduler) {
      await CrmSchedulerConfig.create(defaultSchedulerConfig);
      console.log("Seeded CRM scheduler configuration.");
    } else {
      console.log("CrmSchedulerConfig already exists. Skipping scheduler config.");
    }

    console.log("CRM configuration seeding completed successfully.");
    process.exit(0);
  } catch (err) {
    console.error("Error during CRM configuration seeding:", err);
    process.exit(1);
  }
}

if (require.main === module) {
  seedCrmConfig();
}

module.exports = { seedCrmConfig, defaultPipelineStages, defaultEventTypes, defaultReplyKeywords, defaultSchedulerConfig };
