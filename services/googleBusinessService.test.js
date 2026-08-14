"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const service = require("./googleBusinessService");

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
});
