"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const Business = require("../models/Business");
const Category = require("../models/Category");
const SubCategory = require("../models/SubCategory");
const googleBusinessService = require("./googleBusinessService");
const businessService = require("./businessService");
const service = require("./googleBusinessImportService");

const user = { _id: new mongoose.Types.ObjectId(), full_name: "Art Brain Owner", tenantId: new mongoose.Types.ObjectId() };
const categoryId = new mongoose.Types.ObjectId();

function artBrainProfile(overrides = {}) {
  return {
    businessId: "locations/111111",
    accountName: "accounts/999",
    businessName: "Art Brain",
    category: "Art Studio",
    additionalCategories: ["Gallery"],
    address: {
      streetName: "12 MG Road",
      city: "Bengaluru",
      state: "Karnataka",
      pincode: "560001",
      country: "IN",
      formattedAddress: "12 MG Road, Bengaluru, Karnataka, 560001, IN",
    },
    phoneNumber: "+919876500000",
    additionalPhones: [],
    website: "https://artbrain.example",
    description: "A creative studio.",
    businessHours: { periods: [] },
    locationDetails: { latitude: 12.97, longitude: 77.59 },
    mapsUri: "https://maps.google.com/?cid=123",
    openStatus: "OPEN",
    ...overrides,
  };
}

// ---- mapGoogleHoursToBusinessTiming ----------------------------------------------------

test("mapGoogleHoursToBusinessTiming maps normal weekday hours", () => {
  const result = service.mapGoogleHoursToBusinessTiming([
    { openDay: "MONDAY", openTime: { hours: 9, minutes: 0 }, closeDay: "MONDAY", closeTime: { hours: 18, minutes: 30 } },
    { openDay: "TUESDAY", openTime: { hours: 9 }, closeDay: "TUESDAY", closeTime: { hours: 18 } },
  ]);
  assert.deepEqual(result.daysOfWeek, ["Mon", "Tue"]);
  assert.deepEqual(result.schedule.Mon, [{ openAt: "09:00", closeAt: "18:30" }]);
  assert.equal(result.isOpen24Hours, false);
});

test("mapGoogleHoursToBusinessTiming detects a full 24-hour day and the all-week 24h flag", () => {
  const allDays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];
  const nextDayOf = { MONDAY: "TUESDAY", TUESDAY: "WEDNESDAY", WEDNESDAY: "THURSDAY", THURSDAY: "FRIDAY", FRIDAY: "SATURDAY", SATURDAY: "SUNDAY", SUNDAY: "MONDAY" };
  const periods = allDays.map((day) => ({
    openDay: day,
    openTime: { hours: 0, minutes: 0 },
    closeDay: nextDayOf[day],
    closeTime: { hours: 0, minutes: 0 },
  }));
  const result = service.mapGoogleHoursToBusinessTiming(periods);
  assert.equal(result.isOpen24Hours, true);
  assert.deepEqual(result.schedule.Mon, [{ openAt: "00:00", closeAt: "23:59" }]);
  assert.equal(result.daysOfWeek.length, 7);
});

test("mapGoogleHoursToBusinessTiming keeps a cross-midnight (non-24h) close time as given", () => {
  const result = service.mapGoogleHoursToBusinessTiming([
    { openDay: "FRIDAY", openTime: { hours: 20, minutes: 0 }, closeDay: "SATURDAY", closeTime: { hours: 2, minutes: 0 } },
  ]);
  assert.deepEqual(result.schedule.Fri, [{ openAt: "20:00", closeAt: "02:00" }]);
  assert.equal(result.isOpen24Hours, false);
});

test("mapGoogleHoursToBusinessTiming returns an empty schedule for no/invalid periods", () => {
  assert.deepEqual(service.mapGoogleHoursToBusinessTiming([]), { isOpen24Hours: false, daysOfWeek: [], schedule: {} });
  assert.deepEqual(service.mapGoogleHoursToBusinessTiming(undefined), { isOpen24Hours: false, daysOfWeek: [], schedule: {} });
});

// ---- mapProfileToBusinessPayload --------------------------------------------------------

test("mapProfileToBusinessPayload converts a region code to a normalized country name", () => {
  const { businessData } = service.mapProfileToBusinessPayload(artBrainProfile(), user, { categoryId });
  assert.equal(businessData.address.country, "India");
});

test("mapProfileToBusinessPayload requests geocoding when coordinates are absent", () => {
  const { businessData, extra } = service.mapProfileToBusinessPayload(
    artBrainProfile({ locationDetails: { latitude: 0, longitude: 0 } }),
    user,
    { categoryId }
  );
  assert.equal(extra.needsGeocoding, true);
  assert.deepEqual(businessData.address.coordinates, { latitude: 0, longitude: 0 });
});

test("mapProfileToBusinessPayload uses Google's own address fields, never inventing values, and falls back to the shared 'unknown' sentinel only when a required field is truly absent", () => {
  const { businessData } = service.mapProfileToBusinessPayload(
    artBrainProfile({ address: { streetName: "", city: "", state: "", pincode: "", country: "" } }),
    user,
    { categoryId }
  );
  assert.equal(businessData.address.city, "Unknown City");
  assert.equal(businessData.address.state, "Unknown State");
  assert.equal(businessData.address.pincode, "000000");
});

test("mapProfileToBusinessPayload carries googleLocationId, description, website, extra categories, and maps URL into extra", () => {
  const { extra } = service.mapProfileToBusinessPayload(artBrainProfile(), user, {
    categoryId,
    media: { logoUrl: "https://example.com/logo.jpg", photoUrls: ["https://example.com/1.jpg"] },
  });
  assert.equal(extra.googleLocationId, "locations/111111");
  assert.equal(extra.creationSource, "google_business");
  assert.ok(extra.googleLastSyncedAt instanceof Date);
  assert.equal(extra.description, "A creative studio.");
  assert.equal(extra.website, "https://artbrain.example");
  assert.deepEqual(extra.servicesTypes, ["Gallery"]);
  assert.equal(extra.socialLinks.googleMaps, "https://maps.google.com/?cid=123");
  assert.equal(extra.businessLogo, "https://example.com/logo.jpg");
  assert.deepEqual(extra.photos, ["https://example.com/1.jpg"]);
});

// ---- findLinkedBusiness ------------------------------------------------------------------

test("findLinkedBusiness matches by googleLocationId first, regardless of owner", async (context) => {
  const otherOwnerBusiness = { _id: new mongoose.Types.ObjectId(), userId: new mongoose.Types.ObjectId(), googleLocationId: "locations/111111" };
  let capturedFilter = null;
  context.mock.method(Business, "findOne", async (filter) => {
    capturedFilter = filter;
    return "googleLocationId" in filter ? otherOwnerBusiness : null;
  });
  const found = await service.findLinkedBusiness(user._id, artBrainProfile());
  assert.equal(found, otherOwnerBusiness);
  assert.equal(capturedFilter.googleLocationId, "locations/111111");
});

test("findLinkedBusiness links an exact-name manual business only when phone or address corroborates the match", async (context) => {
  context.mock.method(Business, "findOne", async (filter) => {
    if ("googleLocationId" in filter) return null;
  });
  context.mock.method(Business, "find", async (filter) => {
    assert.equal(String(filter.userId), String(user._id));
    assert.match(filter.businessName.$regex.source, /\^Art Brain\$/i);
    return [{
      _id: "biz1",
      userId: user._id,
      address: { city: "Bengaluru", pincode: "560001" },
      contact: { mobile: [] },
    }];
  });
  const found = await service.findLinkedBusiness(user._id, artBrainProfile());
  assert.equal(found._id, "biz1");
});

test("findLinkedBusiness does not merge a same-name business when ownership evidence does not match", async (context) => {
  context.mock.method(Business, "findOne", async () => null);
  context.mock.method(Business, "find", async () => [{
    _id: "different-biz",
    userId: user._id,
    address: { city: "Mumbai", pincode: "400001" },
    contact: { mobile: ["+91 99999 99999"] },
    location: { coordinates: [72.8, 19.0] },
  }]);
  assert.equal(await service.findLinkedBusiness(user._id, artBrainProfile()), null);
});

// ---- importLocation -----------------------------------------------------------------------

function stubConnectionAndFetch(context, { profile = artBrainProfile(), fetchError = null } = {}) {
  context.mock.method(googleBusinessService, "connection", async () => ({ _id: "conn1", status: "connected" }));
  context.mock.method(googleBusinessService, "fetchProfileByLocationName", async () => {
    if (fetchError) throw fetchError;
    return profile;
  });
  context.mock.method(googleBusinessService, "fetchLocationMedia", async () => ({ logoUrl: null, photoUrls: [], accountVerified: true }));
}

test("importLocation rejects an invalid location id before touching Google or the database", async () => {
  await assert.rejects(() => service.importLocation(user, { locationName: "not-a-location" }), /valid Google location id/);
});

test("importLocation surfaces a Google 403 as NotAuthorizedError (unauthorized location access)", async (context) => {
  const err = new Error("Forbidden");
  err.response = { status: 403 };
  stubConnectionAndFetch(context, { fetchError: err });
  await assert.rejects(
    () => service.importLocation(user, { locationName: "locations/111111", accountName: "accounts/999" }),
    (thrown) => {
      assert.equal(thrown.status, 403);
      return true;
    }
  );
});

test("importLocation creates a new Business via businessService.createBusiness when nothing is linked yet", async (context) => {
  stubConnectionAndFetch(context);
  context.mock.method(Business, "findOne", async () => null);
  context.mock.method(Business, "find", async () => []);
  context.mock.method(Category, "findById", async () => ({ _id: categoryId }));
  let createArgs = null;
  context.mock.method(businessService, "createBusiness", async (args) => {
    createArgs = args;
    return { _id: new mongoose.Types.ObjectId(), businessName: args.businessData.businessName };
  });

  const result = await service.importLocation(user, {
    accountName: "accounts/999",
    locationName: "locations/111111",
    categoryId: String(categoryId),
  });

  assert.equal(result.created, true);
  assert.equal(result.business.businessName, "Art Brain");
  assert.equal(String(createArgs.ownerId), String(user._id));
  assert.equal(createArgs.isAdmin, false);
  assert.equal(createArgs.extra.googleLocationId, "locations/111111");
  assert.equal(createArgs.extra.creationSource, "google_business");
  assert.equal(createArgs.extra.googleAccountName, "accounts/999");
});

test("importLocation requires a category when none is supplied and no name match exists", async (context) => {
  stubConnectionAndFetch(context);
  context.mock.method(Business, "findOne", async () => null);
  context.mock.method(Business, "find", async () => []);
  context.mock.method(Category, "findOne", async () => null);

  await assert.rejects(
    () => service.importLocation(user, { accountName: "accounts/999", locationName: "locations/111111" }),
    (thrown) => {
      assert.equal(thrown.status, 400);
      assert.equal(thrown.requiresCategory, true);
      assert.equal(thrown.suggestedCategoryName, "Art Studio");
      return true;
    }
  );
});

test("importLocation defaults the category from an exact name match against Google's primary category", async (context) => {
  stubConnectionAndFetch(context);
  context.mock.method(Business, "findOne", async () => null);
  context.mock.method(Business, "find", async () => []);
  context.mock.method(Category, "findOne", async (filter) => {
    assert.match(filter.name.$regex.source, /Art Studio/i);
    return { _id: categoryId };
  });
  let createArgs = null;
  context.mock.method(businessService, "createBusiness", async (args) => {
    createArgs = args;
    return { _id: new mongoose.Types.ObjectId() };
  });

  await service.importLocation(user, { accountName: "accounts/999", locationName: "locations/111111" });
  assert.equal(String(createArgs.businessData.category[0]), String(categoryId));
});

test("importLocation syncs (does not duplicate) when the location is already linked to the current user's own business", async (context) => {
  stubConnectionAndFetch(context);
  const existing = {
    _id: new mongoose.Types.ObjectId(),
    userId: user._id,
    googleLocationId: "locations/111111",
    address: { city: "Unknown City" },
    location: { coordinates: [0, 0] },
    save: async function () { return this; },
  };
  context.mock.method(Business, "findOne", async () => existing);
  let createCalled = false;
  context.mock.method(businessService, "createBusiness", async () => { createCalled = true; });

  const result = await service.importLocation(user, { accountName: "accounts/999", locationName: "locations/111111" });
  assert.equal(result.created, false);
  assert.equal(result.business.address.city, "Bengaluru"); // filled in by sync
  assert.equal(createCalled, false);
});

test("importLocation refuses to link/import when the location already belongs to a different UC account (no silent ownership transfer)", async (context) => {
  stubConnectionAndFetch(context);
  const otherUsersBusiness = { _id: new mongoose.Types.ObjectId(), userId: new mongoose.Types.ObjectId(), googleLocationId: "locations/111111" };
  context.mock.method(Business, "findOne", async () => otherUsersBusiness);
  let createCalled = false;
  context.mock.method(businessService, "createBusiness", async () => { createCalled = true; });

  await assert.rejects(
    () => service.importLocation(user, { accountName: "accounts/999", locationName: "locations/111111" }),
    (thrown) => {
      assert.equal(thrown.status, 409);
      assert.equal(String(thrown.existingBusinessId), String(otherUsersBusiness._id));
      assert.equal(thrown.claimable, true);
      return true;
    }
  );
  assert.equal(createCalled, false);
});

test("importLocation still creates the business when media (photos/logo) could not be fetched", async (context) => {
  // googleBusinessService.fetchLocationMedia is documented to never throw — a failed media
  // call resolves to { logoUrl: null, photoUrls: [] } — so importLocation must not require
  // media to succeed in order to complete the import.
  context.mock.method(googleBusinessService, "connection", async () => ({ _id: "conn1", status: "connected" }));
  context.mock.method(googleBusinessService, "fetchProfileByLocationName", async () => artBrainProfile());
  context.mock.method(googleBusinessService, "fetchLocationMedia", async () => ({ logoUrl: null, photoUrls: [], accountVerified: false }));
  context.mock.method(Business, "findOne", async () => null);
  context.mock.method(Business, "find", async () => []);
  context.mock.method(Category, "findById", async () => ({ _id: categoryId }));
  let createArgs = null;
  context.mock.method(businessService, "createBusiness", async (args) => {
    createArgs = args;
    return { _id: new mongoose.Types.ObjectId() };
  });

  const result = await service.importLocation(user, { accountName: "accounts/999", locationName: "locations/111111", categoryId: String(categoryId) });
  assert.equal(result.created, true);
  assert.equal(createArgs.extra.businessLogo, undefined);
  assert.equal(createArgs.extra.photos, undefined);
});

test("syncLinkedBusiness refreshes Google-owned fields and sync metadata for a Google-imported Business", async () => {
  let saved = false;
  const business = {
    creationSource: "google_business",
    googleLocationId: "locations/111111",
    googleAccountName: "accounts/old",
    businessName: "Old name",
    description: "Old description",
    website: "https://old.example",
    importedCategory: "Old category",
    servicesTypes: ["Old service"],
    address: { city: "Old City", state: "Old State", pincode: "111111", country: "India", streetName: "Old Street" },
    location: { coordinates: [1, 1] },
    contact: { mobile: ["123"], contactDetails: [{ mobileNumbers: ["123"] }] },
    businessTiming: { daysOfWeek: [], schedule: {} },
    businessLogo: "old-logo",
    photos: ["old-photo"],
    socialLinks: new Map(),
    save: async function () { saved = true; return this; },
  };

  await service.syncLinkedBusiness(
    business,
    artBrainProfile({
      businessName: "Art Brain Updated",
      phoneNumber: "+91 9999999999",
      businessHours: {
        periods: [{ openDay: "MONDAY", openTime: { hours: 9 }, closeDay: "MONDAY", closeTime: { hours: 18 } }],
      },
    }),
    { logoUrl: "https://example.com/new-logo.jpg", photoUrls: ["https://example.com/new-photo.jpg"] },
    { accountName: "accounts/999" }
  );

  assert.equal(saved, true);
  assert.equal(business.businessName, "Art Brain Updated");
  assert.equal(business.googleAccountName, "accounts/999");
  assert.equal(business.contact.mobile[0], "+91 9999999999");
  assert.deepEqual(business.businessTiming.daysOfWeek, ["Mon"]);
  assert.equal(business.businessLogo, "https://example.com/new-logo.jpg");
  assert.ok(business.googleLastSyncedAt instanceof Date);
});
