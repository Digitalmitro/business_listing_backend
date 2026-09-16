"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const Business = require("../models/Business");
const User = require("../models/User");
const Category = require("../models/Category");
const SubCategory = require("../models/SubCategory");
const notificationHelper = require("../helpers/notificationHelper");
const queue = require("../utils/queue");
const service = require("./businessService");

const categoryId = new mongoose.Types.ObjectId();
const ownerId = new mongoose.Types.ObjectId();

function stubCategoryLookup(context, { categories = [categoryId], subCategories = [] } = {}) {
  context.mock.method(Category, "find", async () => categories.map((id) => ({ _id: id })));
  context.mock.method(SubCategory, "find", async () => subCategories.map((id) => ({ _id: id })));
}

function stubSaveAndUser(context, { savedBusinessId = new mongoose.Types.ObjectId() } = {}) {
  let savedDoc = null;
  context.mock.method(Business.prototype, "save", async function () {
    if (!this._id) this._id = savedBusinessId;
    savedDoc = this;
    return this;
  });
  const user = { _id: ownerId, businesses: [], isSeller: false, save: async () => {} };
  context.mock.method(User, "findById", async () => user);
  context.mock.method(notificationHelper, "notifyAdmins", async () => {});
  context.mock.method(queue, "addJob", async () => {});
  return { user, getSavedDoc: () => savedDoc };
}

test("createBusiness rejects when coordinates are missing and geocoding is not requested", async () => {
  await assert.rejects(
    () =>
      service.createBusiness({
        ownerId,
        isAdmin: false,
        businessData: {
          businessName: "Art Brain",
          address: { pincode: "110001", city: "Delhi", state: "Delhi", country: "India" },
          category: [categoryId],
        },
      }),
    /Latitude and longitude are required/
  );
});

test("createBusiness rejects when no category is provided", async (context) => {
  stubCategoryLookup(context, { categories: [] });
  await assert.rejects(
    () =>
      service.createBusiness({
        ownerId,
        isAdmin: false,
        businessData: {
          businessName: "Art Brain",
          address: {
            pincode: "110001",
            city: "Delhi",
            state: "Delhi",
            country: "India",
            coordinates: { latitude: 28.6, longitude: 77.2 },
          },
          category: [],
        },
      }),
    /At least one category is required/
  );
});

test("createBusiness rejects an invalid category id", async (context) => {
  stubCategoryLookup(context, { categories: [] }); // DB returns none => mismatch with requested id
  await assert.rejects(
    () =>
      service.createBusiness({
        ownerId,
        isAdmin: false,
        businessData: {
          businessName: "Art Brain",
          address: {
            pincode: "110001",
            city: "Delhi",
            state: "Delhi",
            country: "India",
            coordinates: { latitude: 28.6, longitude: 77.2 },
          },
          category: [categoryId],
        },
      }),
    /One or more categories are invalid/
  );
});

test("createBusiness builds the same document shape as the manual flow for a valid submission", async (context) => {
  stubCategoryLookup(context);
  const { user, getSavedDoc } = stubSaveAndUser(context);

  const saved = await service.createBusiness({
    ownerId,
    isAdmin: false,
    businessData: {
      businessName: "Art Brain",
      address: {
        pincode: "110001",
        city: "Delhi",
        state: "Delhi",
        country: "USA", // exercises normalizeCountry aliasing
        coordinates: { latitude: 28.6, longitude: 77.2 },
      },
      contact: {
        mobile: ["9876543210"],
        whatsapp: [],
        email: ["owner@artbrain.test"],
        contactDetails: [{ name: "Art Brain Owner" }],
      },
      businessTiming: { isOpen24Hours: false, daysOfWeek: ["Mon"], schedule: {} },
      category: [categoryId],
    },
    files: {},
  });

  assert.equal(saved.businessName, "Art Brain");
  assert.equal(saved.address.country, "United States");
  assert.deepEqual(saved.location.coordinates, [77.2, 28.6]);
  assert.equal(saved.claimed, true);
  assert.equal(saved.isAdmin, false);
  assert.equal(String(saved.userId), String(ownerId));
  assert.equal(saved.contact.contactDetails[0].mobileNumbers[0], "9876543210");
  assert.equal(user.isSeller, true);
  assert.equal(user.businesses.length, 1);
  assert.equal(getSavedDoc(), saved);
});

test("createBusiness preserves each manual contact person's own phone and email arrays", async (context) => {
  stubCategoryLookup(context);
  stubSaveAndUser(context);
  const saved = await service.createBusiness({
    ownerId,
    businessData: {
      businessName: "DigitalMitro",
      address: { pincode: "110001", city: "Delhi", state: "Delhi", country: "India", coordinates: { latitude: 0, longitude: 77.2 } },
      category: [categoryId],
      contact: {
        mobile: ["fallback"],
        contactDetails: [
          { name: "First", mobileNumbers: ["111"], emails: ["first@example.test"] },
          { name: "Second", mobileNumbers: ["222"], emails: ["second@example.test"] },
        ],
      },
    },
  });
  assert.deepEqual(saved.contact.contactDetails[0].mobileNumbers, ["111"]);
  assert.deepEqual(saved.contact.contactDetails[1].mobileNumbers, ["222"]);
  assert.deepEqual(saved.contact.contactDetails[1].emails, ["second@example.test"]);
  assert.deepEqual(saved.location.coordinates, [77.2, 0]);
});

test("createBusiness sets userId to null and skips the owner attach step for admin-created listings", async (context) => {
  stubCategoryLookup(context);
  let userFindCalled = false;
  context.mock.method(Business.prototype, "save", async function () {
    this._id = new mongoose.Types.ObjectId();
    return this;
  });
  context.mock.method(User, "findById", async () => {
    userFindCalled = true;
    return null;
  });
  context.mock.method(notificationHelper, "notifyAdmins", async () => {});
  context.mock.method(queue, "addJob", async () => {});

  const saved = await service.createBusiness({
    ownerId: null,
    isAdmin: true,
    businessData: {
      businessName: "Admin Listed Co",
      address: {
        pincode: "110001",
        city: "Delhi",
        state: "Delhi",
        country: "India",
        coordinates: { latitude: 28.6, longitude: 77.2 },
      },
      category: [categoryId],
    },
  });

  assert.equal(saved.userId, null);
  assert.equal(saved.claimed, false);
  assert.equal(saved.isAdmin, true);
  assert.equal(userFindCalled, false);
});

test("createBusiness accepts extra.needsGeocoding in place of coordinates and queues a geocoding job (Google import path)", async (context) => {
  stubCategoryLookup(context);
  const { getSavedDoc } = stubSaveAndUser(context);
  let queuedJob = null;
  context.mock.method(queue, "addJob", async (name, data) => {
    queuedJob = { name, data };
  });

  const saved = await service.createBusiness({
    ownerId,
    isAdmin: false,
    businessData: {
      businessName: "DigitalMitro",
      address: { pincode: "000000", city: "Unknown City", state: "Unknown State", country: "Unknown Country" },
      category: [categoryId],
    },
    extra: { needsGeocoding: true, googleLocationId: "locations/123", website: "https://digitalmitro.example" },
  });

  assert.equal(saved.needsGeocoding, true);
  assert.deepEqual(saved.location.coordinates, [0, 0]);
  assert.equal(saved.googleLocationId, "locations/123");
  assert.equal(saved.website, "https://digitalmitro.example");
  assert.ok(queuedJob);
  assert.equal(queuedJob.name, "geocoding-batch");
  assert.equal(queuedJob.data.businessId, getSavedDoc()._id);
});
