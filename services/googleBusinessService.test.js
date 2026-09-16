"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const service = require("./googleBusinessService");
const axios = require("axios");

test("Google Business integration enforces its read-only provider boundary", () => {
  assert.equal(service.READ_ONLY, true);
  assert.equal(service.assertReadOnly("fetch locations"), true);
  assert.throws(() => service.assertReadOnly("update business"), /Read-only violation/);
  assert.throws(() => service.assertReadOnly("DELETE location"), /Read-only violation/);
});

test("normalizeLocation maps the Business Profile read model", () => {
  const normalized = service.normalizeLocation({
    name: "locations/9876543210123",
    title: "Acme Gourmet Kitchen",
    categories: { primaryCategory: { displayName: "Restaurant" } },
    storefrontAddress: {
      addressLines: ["789 Broadway Ave", "Floor 2"],
      locality: "New York",
      administrativeArea: "NY",
      postalCode: "10003",
      regionCode: "US",
    },
    phoneNumbers: { primaryPhone: "+1 212-555-0199" },
    websiteUri: "https://www.acmegourmet.com",
    profile: { description: "Gourmet dining." },
    regularHours: { periods: [{ openDay: "MONDAY" }] },
    latlng: { latitude: 40.729, longitude: -73.993 },
  });

  assert.equal(normalized.businessId, "locations/9876543210123");
  assert.equal(normalized.businessName, "Acme Gourmet Kitchen");
  assert.equal(normalized.category, "Restaurant");
  assert.equal(normalized.address.formattedAddress, "789 Broadway Ave, Floor 2, New York, NY, 10003, US");
  assert.equal(normalized.phoneNumber, "+1 212-555-0199");
  assert.equal(normalized.locationDetails.latitude, 40.729);
});

test("normalizeLocation safely handles absent provider fields", () => {
  const normalized = service.normalizeLocation({});
  assert.equal(normalized.businessId, "");
  assert.equal(normalized.address.formattedAddress, "");
  assert.equal(normalized.locationDetails.latitude, 0);
  assert.deepEqual(normalized.additionalCategories, []);
  assert.deepEqual(normalized.additionalPhones, []);
  assert.equal(normalized.mapsUri, "");
  assert.equal(normalized.openStatus, "");
});

test("normalizeLocation additionally maps additional categories/phones, the accountName carried in by the caller, maps URL, and open status", () => {
  const normalized = service.normalizeLocation({
    accountName: "accounts/12345",
    name: "locations/9876543210123",
    title: "Acme Gourmet Kitchen",
    categories: {
      primaryCategory: { displayName: "Restaurant" },
      additionalCategories: [{ displayName: "Bakery" }, { displayName: "" }],
    },
    phoneNumbers: { primaryPhone: "+1 212-555-0199", additionalPhones: ["+1 212-555-0200"] },
    metadata: { mapsUri: "https://maps.google.com/?cid=999" },
    openInfo: { status: "OPEN" },
  });

  assert.equal(normalized.accountName, "accounts/12345");
  assert.deepEqual(normalized.additionalCategories, ["Bakery"]);
  assert.deepEqual(normalized.additionalPhones, ["+1 212-555-0200"]);
  assert.equal(normalized.mapsUri, "https://maps.google.com/?cid=999");
  assert.equal(normalized.openStatus, "OPEN");
});

test("fetchLocationMedia rejects a malformed accountName/locationName without calling Google", async () => {
  const result = await service.fetchLocationMedia({ _id: "u1" }, "not-an-account", "locations/1");
  assert.deepEqual(result, { logoUrl: null, photoUrls: [], accountVerified: false });
});

test("fetchLocationMedia returns an empty result (never throws) when the underlying call fails, e.g. no usable Google connection", async () => {
  const result = await service.fetchLocationMedia({ _id: "u1" }, "accounts/1", "locations/1");
  assert.deepEqual(result, { logoUrl: null, photoUrls: [], accountVerified: false });
});

test("fetchAllPages follows Google nextPageToken without dropping results", async (context) => {
  const seenTokens = [];
  context.mock.method(axios, "get", async (_url, options) => {
    seenTokens.push(options.params.pageToken || null);
    if (!options.params.pageToken) return { data: { locations: [{ name: "locations/1" }], nextPageToken: "next" } };
    return { data: { locations: [{ name: "locations/2" }] } };
  });
  const locations = await service.fetchAllPages("https://example.test/locations", {
    headers: { Authorization: "Bearer redacted" },
    params: { readMask: "name" },
    itemKey: "locations",
    pageSize: 100,
  });
  assert.deepEqual(seenTokens, [null, "next"]);
  assert.deepEqual(locations.map((location) => location.name), ["locations/1", "locations/2"]);
});
