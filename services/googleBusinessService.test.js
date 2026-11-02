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

function googleHttpError(status, error) {
  return Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data: { error } } });
}

test("toGoogleApiError names a disabled API and links to where it is enabled, instead of calling it 'not approved'", () => {
  const mapped = service.toGoogleApiError(googleHttpError(403, {
    code: 403,
    status: "PERMISSION_DENIED",
    message: "My Business Account Management API has not been used in project 157093348458 before or it is disabled.",
    details: [{
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason: "SERVICE_DISABLED",
      metadata: {
        service: "mybusinessaccountmanagement.googleapis.com",
        consumer: "projects/157093348458",
        activationUrl: "https://console.developers.google.com/apis/api/mybusinessaccountmanagement.googleapis.com/overview?project=157093348458",
      },
    }],
  }));
  assert.equal(mapped.status, 403);
  assert.equal(mapped.code, "api_disabled");
  assert.match(mapped.message, /mybusinessaccountmanagement\.googleapis\.com is not enabled/);
  assert.match(mapped.message, /157093348458/);
  assert.match(mapped.message, /overview\?project=157093348458/);
});

test("toGoogleApiError asks the user to reconnect when the Business Profile permission was not granted", () => {
  const mapped = service.toGoogleApiError(googleHttpError(403, {
    status: "PERMISSION_DENIED",
    message: "Request had insufficient authentication scopes.",
    details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }],
  }));
  assert.equal(mapped.status, 401);
  assert.equal(mapped.code, "scope_missing");
});

test("toGoogleApiError reports a zero quota as an unapproved project and an ordinary 429 as a rate limit", () => {
  const notApproved = service.toGoogleApiError(googleHttpError(429, {
    status: "RESOURCE_EXHAUSTED",
    message: "Quota exceeded for quota metric 'Requests' and limit 'Requests per minute' of service 'mybusinessaccountmanagement.googleapis.com' for consumer 'project_number:157093348458'.",
    details: [{ reason: "RATE_LIMIT_EXCEEDED", metadata: { quota_limit_value: "0", consumer: "projects/157093348458" } }],
  }));
  assert.equal(notApproved.code, "api_not_approved");
  assert.equal(notApproved.status, 403);

  const throttled = service.toGoogleApiError(googleHttpError(429, {
    status: "RESOURCE_EXHAUSTED",
    details: [{ reason: "RATE_LIMIT_EXCEEDED", metadata: { quota_limit_value: "300" } }],
  }));
  assert.equal(throttled.code, "rate_limited");
  assert.equal(throttled.status, 429);
});

test("toGoogleApiError passes Google's own message through for other 403s and ignores non-HTTP errors", () => {
  const mapped = service.toGoogleApiError(googleHttpError(403, { status: "PERMISSION_DENIED", message: "The caller does not have permission" }));
  assert.equal(mapped.code, "google_forbidden");
  assert.match(mapped.message, /The caller does not have permission/);
  assert.equal(service.toGoogleApiError(new Error("socket hang up")), null);
});

test("only Google Owner roles may move a listing between UrbanCitations accounts", () => {
  assert.equal(service.OWNER_ROLES.has("OWNER"), true);
  assert.equal(service.OWNER_ROLES.has("PRIMARY_OWNER"), true);
  assert.equal(service.OWNER_ROLES.has("MANAGER"), false);
  assert.equal(service.OWNER_ROLES.has("SITE_MANAGER"), false);
});
