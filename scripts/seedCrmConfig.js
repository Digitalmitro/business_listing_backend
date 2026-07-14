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

const defaultPipelineStages = [
  { name: "New", order: 1, probability: 10, color: "#3b82f6", isDefault: true, isWon: false, isLost: false },
  { name: "Prospecting", order: 2, probability: 20, color: "#6366f1", isDefault: false, isWon: false, isLost: false },
  { name: "Qualification", order: 3, probability: 30, color: "#8b5cf6", isDefault: false, isWon: false, isLost: false },
  { name: "Meeting/Demo", order: 4, probability: 50, color: "#ec4899", isDefault: false, isWon: false, isLost: false },
  { name: "Proposal", order: 5, probability: 65, color: "#f59e0b", isDefault: false, isWon: false, isLost: false },
  { name: "Negotiation", order: 6, probability: 80, color: "#14b8a6", isDefault: false, isWon: false, isLost: false },
  { name: "Pending Follow-Up", order: 7, probability: 40, color: "#06b6d4", isDefault: false, isWon: false, isLost: false },
  { name: "Follow-Up Sent", order: 8, probability: 45, color: "#0ea5e9", isDefault: false, isWon: false, isLost: false },
  { name: "Warm Lead", order: 9, probability: 70, color: "#10b981", isDefault: false, isWon: false, isLost: false },
  { name: "Cold Lead", order: 10, probability: 15, color: "#64748b", isDefault: false, isWon: false, isLost: false },
  { name: "Closed Won", order: 11, probability: 100, color: "#22c55e", isDefault: false, isWon: true, isLost: false },
  { name: "Closed Lost", order: 12, probability: 0, color: "#ef4444", isDefault: false, isWon: false, isLost: true },
  { name: "Completed", order: 13, probability: 100, color: "#16a34a", isDefault: false, isWon: true, isLost: false },
];

const defaultEventTypes = [
  { name: "Meeting", color: "#3b82f6", icon: "video", durationMinutes: 30, isActive: true },
  { name: "Call", color: "#10b981", icon: "phone", durationMinutes: 15, isActive: true },
  { name: "Demo", color: "#8b5cf6", icon: "desktop", durationMinutes: 45, isActive: true },
  { name: "Follow-Up", color: "#f59e0b", icon: "clock", durationMinutes: 15, isActive: true },
  { name: "Task", color: "#64748b", icon: "check-square", durationMinutes: 30, isActive: true },
];

const defaultReplyKeywords = [
  // Positive / Warm keywords
  { keyword: "interested", category: "positive", scoreBonus: 25, newStatus: "Warm Lead", isActive: true },
  { keyword: "yes", category: "positive", scoreBonus: 15, newStatus: "Warm Lead", isActive: true },
  { keyword: "more info", category: "positive", scoreBonus: 20, newStatus: "Qualification", isActive: true },
  { keyword: "demo", category: "positive", scoreBonus: 30, newStatus: "Meeting/Demo", isActive: true },
  { keyword: "pricing", category: "positive", scoreBonus: 25, newStatus: "Proposal", isActive: true },
  { keyword: "quote", category: "positive", scoreBonus: 25, newStatus: "Proposal", isActive: true },
  { keyword: "schedule", category: "positive", scoreBonus: 30, newStatus: "Meeting/Demo", isActive: true },
  { keyword: "meeting", category: "positive", scoreBonus: 30, newStatus: "Meeting/Demo", isActive: true },
  // Negative / Cold keywords
  { keyword: "unsubscribe", category: "negative", scoreBonus: -50, newStatus: "Cold Lead", isActive: true },
  { keyword: "stop", category: "negative", scoreBonus: -50, newStatus: "Cold Lead", isActive: true },
  { keyword: "remove", category: "negative", scoreBonus: -40, newStatus: "Cold Lead", isActive: true },
  { keyword: "not interested", category: "negative", scoreBonus: -30, newStatus: "Cold Lead", isActive: true },
  { keyword: "spam", category: "negative", scoreBonus: -50, newStatus: "Cold Lead", isActive: true },
  // Neutral / Question keywords
  { keyword: "when", category: "neutral", scoreBonus: 5, newStatus: null, isActive: true },
  { keyword: "how much", category: "neutral", scoreBonus: 10, newStatus: "Proposal", isActive: true },
  { keyword: "question", category: "neutral", scoreBonus: 5, newStatus: null, isActive: true },
];

const defaultSchedulerConfig = {
  followUpDaysDefault: Number(process.env.CRM_FOLLOWUP_DAYS_DEFAULT || 3),
  maxFollowUpsPerDay: Number(process.env.CRM_MAX_FOLLOWUPS_PER_DAY || 100),
  dailyDigestHour: Number(process.env.CRM_DIGEST_HOUR || 8),
  cronIntervalMinutes: Number(process.env.CRM_CRON_INTERVAL_MINUTES || 60),
  autoConvertColdDays: Number(process.env.CRM_AUTO_COLD_DAYS || 30),
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
    const existingScheduler = await CrmSchedulerConfig.findOne();
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
