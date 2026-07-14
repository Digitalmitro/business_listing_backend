"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const {
  READ_ONLY,
  assertReadOnly,
  normalizeLocation,
  getAuthUrl,
  getValidAccessToken,
} = require("./googleBusinessService");
const { encrypt } = require("../utils/cryptoUtils");
const { closeQueueConnections } = require("../utils/queue");

test("READ_ONLY flag is true and assertReadOnly throws error", () => {
  assert.equal(READ_ONLY, true);
  assert.throws(() => {
    assertReadOnly("update_business");
  }, /Read-only violation/i);
});

test("getAuthUrl generates correct Google authorization URL with business scopes", () => {
  const url = getAuthUrl("test_state_123");
  assert.match(url, /https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth/);
  assert.match(url, /business\.manage/);
  assert.match(url, /state=test_state_123/);
});

test("normalizeLocation formats raw location into exact 9 required fields", () => {
  const rawLocation = {
    name: "locations/9876543210123",
    title: "Acme Gourmet Kitchen",
    categories: {
      primaryCategory: {
        displayName: "Restaurant",
      },
    },
    storefrontAddress: {
      addressLines: ["789 Broadway Ave", "Floor 2"],
      locality: "New York",
      administrativeArea: "NY",
      postalCode: "10003",
      regionCode: "US",
    },
    phoneNumbers: {
      primaryPhone: "+1 212-555-0199",
    },
    websiteUri: "https://www.acmegourmet.com",
    profile: {
      description: "Authentic gourmet dining in the heart of NYC.",
    },
    regularHours: {
      periods: [
        {
          openDay: "MONDAY",
          openTime: { hours: 10, minutes: 0 },
          closeDay: "MONDAY",
          closeTime: { hours: 22, minutes: 0 },
        },
      ],
    },
    latlng: {
      latitude: 40.729,
      longitude: -73.993,
    },
  };

  const normalized = normalizeLocation(rawLocation);

  // Verify all 9 required fields
  assert.equal(normalized.businessId, "locations/9876543210123");
  assert.equal(normalized.businessName, "Acme Gourmet Kitchen");
  assert.equal(normalized.category, "Restaurant");
  assert.equal(normalized.address.streetName, "789 Broadway Ave, Floor 2");
  assert.equal(normalized.address.city, "New York");
  assert.equal(normalized.address.state, "NY");
  assert.equal(normalized.address.pincode, "10003");
  assert.equal(normalized.address.country, "US");
  assert.equal(
    normalized.address.formattedAddress,
    "789 Broadway Ave, Floor 2, New York, NY, 10003, US"
  );
  assert.equal(normalized.phoneNumber, "+1 212-555-0199");
  assert.equal(normalized.website, "https://www.acmegourmet.com");
  assert.equal(normalized.description, "Authentic gourmet dining in the heart of NYC.");
  assert.equal(normalized.businessHours.periods.length, 1);
  assert.equal(normalized.locationDetails.latitude, 40.729);
  assert.equal(normalized.locationDetails.longitude, -73.993);
});

test("normalizeLocation safely handles empty or missing raw fields", () => {
  const normalized = normalizeLocation({});
  assert.equal(normalized.businessId, "");
  assert.equal(normalized.businessName, "");
  assert.equal(normalized.category, "");
  assert.equal(normalized.phoneNumber, "");
  assert.equal(normalized.website, "");
  assert.equal(normalized.description, "");
  assert.equal(normalized.locationDetails.latitude, 0);
  assert.equal(normalized.locationDetails.longitude, 0);
});

test("getValidAccessToken decrypts existing token when not expired", async () => {
  const mockUser = {
    googleBusinessProfile: {
      isConnected: true,
      accessToken: encrypt("fresh_access_token_abc"),
      tokenExpiry: new Date(Date.now() + 60 * 60 * 1000), // 1 hour in future
    },
  };

  const token = await getValidAccessToken(mockUser);
  assert.equal(token, "fresh_access_token_abc");
});

test("getValidAccessToken throws error when account is not connected", async () => {
  await assert.rejects(
    async () => {
      await getValidAccessToken({ googleBusinessProfile: { isConnected: false } });
    },
    /User has not connected a Google Business Profile account/
  );
});

after(async () => {
  try {
    await closeQueueConnections();
  } catch (e) {}
});
