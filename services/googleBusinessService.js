"use strict";

const { OAuth2Client } = require("google-auth-library");
const axios = require("axios");
const logger = require("../utils/logger");
const { encrypt, decrypt } = require("../utils/cryptoUtils");

// Strict Read-Only Flag Enforcement
const READ_ONLY = true;

/**
 * Ensures read-only interactions with Google Business Profile.
 * Throws an error if any modification action is attempted.
 */
function assertReadOnly(operation = "unknown_write_operation") {
  if (READ_ONLY) {
    const errorMsg = `Read-only violation: Operation '${operation}' is forbidden. This Google Business Profile integration is strictly read-only.`;
    logger.error(errorMsg);
    throw new Error(errorMsg);
  }
}

/**
 * Creates and returns an OAuth2Client configured for Google Business Profile.
 */
function getOAuthClient() {
  return new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID || "mock_client_id",
    process.env.GOOGLE_CLIENT_SECRET || "mock_client_secret",
    process.env.GOOGLE_REDIRECT_URI || "http://localhost:5000/api/google-business/callback"
  );
}

/**
 * Generates the Google OAuth authorization URL for connecting a Google Business Profile account.
 * @param {string} state - Optional state string (e.g., serialized userId or redirect details).
 * @returns {string} Authorization consent URL.
 */
function getAuthUrl(state = "") {
  const client = getOAuthClient();
  const scopes = [
    "https://www.googleapis.com/auth/business.manage",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
  ];

  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: scopes,
    state,
  });
}

/**
 * Exchanges authorization code for tokens (`access_token`, `refresh_token`, `expiry_date`).
 * @param {string} code - Authorization code from callback.
 * @returns {Promise<Object>} Token information including encrypted tokens and email/id if available.
 */
async function exchangeCodeForTokens(code) {
  if (!code) {
    throw new Error("Authorization code is required");
  }

  const client = getOAuthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  let googleEmail = "";
  let googleAccountId = "";

  try {
    const userInfoRes = await axios.get("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    googleEmail = userInfoRes.data?.email || "";
    googleAccountId = userInfoRes.data?.id || "";
  } catch (err) {
    logger.warn("Could not fetch userinfo profile after token exchange", { error: err.message });
  }

  const expiryDate = tokens.expiry_date
    ? new Date(tokens.expiry_date)
    : new Date(Date.now() + (tokens.expires_in || 3600) * 1000);

  return {
    accessToken: encrypt(tokens.access_token),
    refreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
    tokenExpiry: expiryDate,
    googleEmail,
    googleAccountId,
  };
}

/**
 * Retrieves a valid, decrypted access token for a user.
 * Automatically refreshes the access token via Google if expired or about to expire within 5 minutes.
 * @param {Object} user - Mongoose User document with `googleBusinessProfile`.
 * @returns {Promise<string>} Valid decrypted access token.
 */
async function getValidAccessToken(user) {
  if (!user || !user.googleBusinessProfile || !user.googleBusinessProfile.isConnected) {
    throw new Error("User has not connected a Google Business Profile account.");
  }

  const gmbProfile = user.googleBusinessProfile;
  const now = new Date();
  const expiry = gmbProfile.tokenExpiry ? new Date(gmbProfile.tokenExpiry) : new Date(0);

  // If token is still valid (more than 5 mins until expiration)
  if (gmbProfile.accessToken && expiry.getTime() - now.getTime() > 5 * 60 * 1000) {
    const decryptedAccess = decrypt(gmbProfile.accessToken);
    if (decryptedAccess) return decryptedAccess;
  }

  // Token expired or close to expiry -> Refresh
  if (!gmbProfile.refreshToken) {
    throw new Error("Google access token has expired and no refresh token is available. Please reconnect your Google account.");
  }

  const decryptedRefresh = decrypt(gmbProfile.refreshToken);
  if (!decryptedRefresh) {
    throw new Error("Invalid refresh token. Please reconnect your Google account.");
  }

  const client = getOAuthClient();
  client.setCredentials({ refresh_token: decryptedRefresh });

  try {
    const { credentials } = await client.refreshAccessToken();
    const newAccessToken = credentials.access_token;
    const newExpiry = credentials.expiry_date
      ? new Date(credentials.expiry_date)
      : new Date(Date.now() + (credentials.expires_in || 3600) * 1000);

    // Update user document if it's a Mongoose document with .save()
    gmbProfile.accessToken = encrypt(newAccessToken);
    gmbProfile.tokenExpiry = newExpiry;
    if (credentials.refresh_token) {
      gmbProfile.refreshToken = encrypt(credentials.refresh_token);
    }

    if (typeof user.save === "function") {
      await user.save();
      logger.info("Successfully refreshed and saved Google Business Profile access token for user", {
        userId: user._id,
      });
    }

    return newAccessToken;
  } catch (err) {
    logger.error("Failed to refresh Google Business Profile access token", { error: err.message });
    throw new Error("Failed to refresh Google token. Please reconnect your Google account.");
  }
}

/**
 * Normalizes a raw Google Business Profile location object into the exactly required 9 fields:
 * 1. Business Name
 * 2. Category
 * 3. Address
 * 4. Phone Number
 * 5. Website
 * 6. Description
 * 7. Business Hours
 * 8. Location Details
 * 9. Business ID
 * @param {Object} location - Raw location object from Google Business Information API.
 * @returns {Object} Normalized profile data.
 */
function normalizeLocation(location = {}) {
  const addressLines = Array.isArray(location.storefrontAddress?.addressLines)
    ? location.storefrontAddress.addressLines.join(", ")
    : location.storefrontAddress?.addressLines || "";

  const locality = location.storefrontAddress?.locality || "";
  const adminArea = location.storefrontAddress?.administrativeArea || "";
  const postalCode = location.storefrontAddress?.postalCode || "";
  const regionCode = location.storefrontAddress?.regionCode || "";

  const formattedAddress = [addressLines, locality, adminArea, postalCode, regionCode]
    .filter(Boolean)
    .join(", ");

  return {
    businessId: location.name || "", // e.g. "locations/123456789"
    businessName: location.title || "",
    category: location.categories?.primaryCategory?.displayName || "",
    address: {
      streetName: addressLines,
      city: locality,
      state: adminArea,
      pincode: postalCode,
      country: regionCode,
      formattedAddress,
    },
    phoneNumber: location.phoneNumbers?.primaryPhone || "",
    website: location.websiteUri || "",
    description: location.profile?.description || "",
    businessHours: {
      isOpen24Hours: false,
      periods: location.regularHours?.periods || [],
    },
    locationDetails: {
      latitude: location.latlng?.latitude || 0,
      longitude: location.latlng?.longitude || 0,
    },
  };
}

/**
 * Fetches all available Business Profiles (locations) across all accounts accessible by the user.
 * Strictly read-only (`GET` requests only).
 * @param {Object} user - User document.
 * @returns {Promise<Array<Object>>} Array of normalized Business Profiles containing all 9 fields.
 */
async function fetchAllProfilesForUser(user) {
  const accessToken = await getValidAccessToken(user);
  const headers = { Authorization: `Bearer ${accessToken}` };

  let accounts = [];
  try {
    const accountsRes = await axios.get("https://mybusinessaccountmanagement.googleapis.com/v1/accounts", {
      headers,
    });
    accounts = accountsRes.data?.accounts || [];
  } catch (err) {
    logger.error("Error fetching Google Business Profile accounts", { error: err.message });
    if (err.response?.status === 401 || err.response?.status === 403) {
      throw new Error("Unauthorized to access Google Business Profile accounts. Check permissions and scopes.");
    }
    throw new Error(`Google API error when listing accounts: ${err.message}`);
  }

  const profiles = [];
  for (const account of accounts) {
    if (!account.name) continue;
    try {
      const locationsRes = await axios.get(
        `https://mybusinessbusinessinformation.googleapis.com/v1/${account.name}/locations?readMask=name,title,categories,storefrontAddress,phoneNumbers,websiteUri,profile,regularHours,latlng`,
        { headers }
      );
      const locations = locationsRes.data?.locations || [];
      for (const loc of locations) {
        profiles.push(normalizeLocation(loc));
      }
    } catch (err) {
      logger.warn(`Error fetching locations for account ${account.name}`, { error: err.message });
    }
  }

  logger.info("Successfully fetched and normalized available GMB profiles", {
    userId: user._id,
    profileCount: profiles.length,
  });

  return profiles;
}

/**
 * Fetches a single specific Business Profile location by its name ID (`locations/xyz`).
 * @param {Object} user - User document.
 * @param {string} locationName - The location ID string (e.g. "locations/123456789").
 * @returns {Promise<Object>} Normalized profile containing all 9 fields.
 */
async function fetchProfileByLocationName(user, locationName) {
  if (!locationName || !locationName.startsWith("locations/")) {
    throw new Error("Invalid location ID format. Must start with 'locations/'");
  }

  const accessToken = await getValidAccessToken(user);
  try {
    const res = await axios.get(
      `https://mybusinessbusinessinformation.googleapis.com/v1/${locationName}?readMask=name,title,categories,storefrontAddress,phoneNumbers,websiteUri,profile,regularHours,latlng`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    return normalizeLocation(res.data);
  } catch (err) {
    logger.error(`Error fetching GMB location ${locationName}`, { error: err.message });
    throw new Error(`Could not fetch Business Profile: ${err.message}`);
  }
}

module.exports = {
  READ_ONLY,
  assertReadOnly,
  getAuthUrl,
  exchangeCodeForTokens,
  getValidAccessToken,
  normalizeLocation,
  fetchAllProfilesForUser,
  fetchProfileByLocationName,
};
