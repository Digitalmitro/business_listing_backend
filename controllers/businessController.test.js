"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const Business = require("../models/Business");
const Enquiry = require("../models/Enquiry");
const Offer = require("../models/Offer");
const { closeQueueConnections } = require("../utils/queue");
const { getBusinessById } = require("./businessController");

test.after(async () => {
  await closeQueueConnections();
});

test("getBusinessById returns a business fetched with lean", async () => {
  const originalFindById = Business.findById;
  const originalCountDocuments = Enquiry.countDocuments;
  const originalOfferFind = Offer.find;

  try {
    const leanBusiness = {
      _id: "business-123",
      businessName: "Test Business",
      category: [],
      subCategory: [],
      photos: [],
      socialLinks: {},
      businessTiming: { isOpen24Hours: false, daysOfWeek: [], schedule: {} },
      kyc: { status: "pending" },
      contact: { mobile: [], email: [], contactDetails: [] },
      yearsOfEstablishment: 0,
    };

    Business.findById = () => {
      const query = {
        populate: () => query,
        lean: async () => leanBusiness,
      };
      return query;
    };
    Enquiry.countDocuments = async () => 2;
    Offer.find = () => {
      const query = {
        populate: () => query,
        sort: async () => [],
      };
      return query;
    };

    let statusCode = 200;
    let responseBody;
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(body) {
        responseBody = body;
        return this;
      },
    };

    await getBusinessById({ params: { id: leanBusiness._id } }, res);

    assert.equal(statusCode, 200);
    assert.equal(responseBody.success, true);
    assert.equal(responseBody.business._id, leanBusiness._id);
    assert.equal(responseBody.business.businessName, leanBusiness.businessName);
    assert.equal(responseBody.business.enquiryCount, 2);
    assert.equal(responseBody.business.offerCount, 0);
  } finally {
    Business.findById = originalFindById;
    Enquiry.countDocuments = originalCountDocuments;
    Offer.find = originalOfferFind;
  }
});
