"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { updateCampaign } = require("./emailCampaignController");
const EmailCampaign = require("../models/EmailCampaign");
const EmailTemplate = require("../models/EmailTemplate");
const User = require("../models/User");
const { emailQueue, closeQueueConnections } = require("../utils/queue");

test.after(async () => {
  await closeQueueConnections();
});

test("updateCampaign allows editing an already-sent campaign without changing schedule", async () => {
  const originalFindOne = EmailCampaign.findOne;
  const originalUserFind = User.find;
  try {
    const mockCampaign = {
      _id: "campaign-123",
      createdBy: "user-123",
      name: "Old Campaign Name",
      status: "sent",
      recipients: {
        users: [],
        customEmails: [],
      },
      save: async function () {
        this.saved = true;
        return this;
      },
    };

    EmailCampaign.findOne = async (query) => {
      if (query._id === "campaign-123" && query.createdBy === "user-123") {
        return mockCampaign;
      }
      return null;
    };
    User.find = async () => [];

    const req = {
      params: { id: "campaign-123" },
      user: { id: "user-123" },
      body: {
        name: "Updated Campaign Name",
      },
    };

    let statusCode = null;
    let jsonResponse = null;
    const res = {
      status: function (code) {
        statusCode = code;
        return this;
      },
      json: function (data) {
        jsonResponse = data;
        return this;
      },
    };

    await updateCampaign(req, res);

    assert.equal(statusCode, 200, `Expected status 200 but got ${statusCode} (${JSON.stringify(jsonResponse)})`);
    assert.equal(jsonResponse.message, "Campaign updated successfully");
    assert.equal(mockCampaign.name, "Updated Campaign Name");
    assert.equal(mockCampaign.saved, true);
    assert.equal(mockCampaign.status, "sent");
  } finally {
    EmailCampaign.findOne = originalFindOne;
    User.find = originalUserFind;
  }
});

test("updateCampaign allows rescheduling an already-sent campaign", async () => {
  const originalFindOne = EmailCampaign.findOne;
  const originalFindById = EmailTemplate.findById;
  const originalUserFind = User.find;
  const originalGetJobs = emailQueue.getJobs;
  const originalAdd = emailQueue.add;

  try {
    const mockCampaign = {
      _id: "campaign-456",
      createdBy: "user-123",
      name: "Sent Campaign",
      status: "sent",
      template: "template-1",
      fromEmail: "test@example.com",
      recipients: {
        users: ["user-1"],
        customEmails: [],
      },
      save: async function () {
        this.saved = true;
        return this;
      },
    };

    EmailCampaign.findOne = async () => mockCampaign;
    EmailTemplate.findById = async (id) => ({ _id: id, name: "Template 1" });
    User.find = async () => [{ _id: "user-1", timeZone: "UTC" }];

    let removedJobIds = [];
    emailQueue.getJobs = async () => [
      {
        id: `email-campaigns-campaign-456-old-job`,
        remove: async () => {
          removedJobIds.push("old-job");
        },
      },
    ];

    let addedJobs = [];
    emailQueue.add = async (queueName, jobData, options) => {
      addedJobs.push({ queueName, jobData, options });
      return { id: options.jobId };
    };

    const futureDate = new Date(Date.now() + 86400000).toISOString().replace("T", " ").substring(0, 16); // Tomorrow YYYY-MM-DD HH:mm

    const req = {
      params: { id: "campaign-456" },
      user: { id: "user-123" },
      body: {
        name: "Rescheduled Campaign",
        scheduledAt: futureDate,
        timeZone: "UTC",
      },
    };

    let statusCode = null;
    let jsonResponse = null;
    const res = {
      status: function (code) {
        statusCode = code;
        return this;
      },
      json: function (data) {
        jsonResponse = data;
        return this;
      },
    };

    await updateCampaign(req, res);

    assert.equal(statusCode, 200, `Expected status 200 but got ${statusCode} (${JSON.stringify(jsonResponse)})`);
    assert.equal(jsonResponse.message, "Campaign updated successfully");
    assert.equal(mockCampaign.name, "Rescheduled Campaign");
    assert.equal(mockCampaign.status, "scheduled");
    assert.equal(mockCampaign.saved, true);
    assert.equal(removedJobIds.length, 1);
    assert.equal(addedJobs.length, 1);
  } finally {
    EmailCampaign.findOne = originalFindOne;
    EmailTemplate.findById = originalFindById;
    User.find = originalUserFind;
    emailQueue.getJobs = originalGetJobs;
    emailQueue.add = originalAdd;
  }
});
