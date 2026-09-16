"use strict";
const { OAuth2Client } = require("google-auth-library");
const axios = require("axios");
const crypto = require("node:crypto");
const logger = require("../utils/logger");
const { encrypt, decrypt } = require("../utils/cryptoUtils");
const OAuthState = require("../models/OAuthState");
const GoogleConnection = require("../models/GoogleBusinessConnection");
const TenantSocialCredential = require("../models/TenantSocialCredential");
const READ_ONLY = true;
const SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/business.manage",
];
async function oauth(tenantId) {
  let clientId, clientSecret, redirect;
  const row = await TenantSocialCredential.findOne({ tenantId, platform: "google_business", enabled: true }).select("+clientId +clientSecret");
  if (row) {
    clientId = decrypt(row.clientId);
    clientSecret = decrypt(row.clientSecret);
    redirect = row.redirectUri;
  } else {
    clientId = process.env.GOOGLE_BUSINESS_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
    clientSecret = process.env.GOOGLE_BUSINESS_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
    redirect = process.env.GOOGLE_BUSINESS_REDIRECT_URI || `${process.env.BACKEND_URL || "http://localhost:8000"}/api/google-business/callback`;
  }
  if (!clientId || !clientSecret) throw new Error("Google Business Profile is not configured for this tenant");
  if (process.env.NODE_ENV === "production" && !/^https:\/\//i.test(redirect)) throw new Error("Google redirect URI must use HTTPS in production");
  return { client: new OAuth2Client(clientId, clientSecret, redirect), clientId, redirect };
}
async function createAuthorizationRequest(user, returnTo) {
  const tenantId = user?.tenantId || user?._id;
  if (!tenantId || !user?._id) throw new Error("Tenant context is required");
  const { client, redirect } = await oauth(tenantId);
  const state = crypto.randomBytes(32).toString("hex");
  await OAuthState.create({
    userId: user._id,
    tenantId,
    platform: "google_business",
    stateHash: crypto.createHash("sha256").update(state).digest("hex"),
    redirectUri: redirect,
    returnTo: returnTo || "/settings/integrations",
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });
  return client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES, state });
}
async function consume(state) {
  const hash = crypto.createHash("sha256").update(String(state || "")).digest("hex");
  const tx = await OAuthState.findOneAndDelete({ platform: "google_business", stateHash: hash, expiresAt: { $gt: new Date() } });
  if (!tx) throw new Error("Invalid or expired OAuth state");
  return tx;
}
async function cancelAuthorizationRequest(state) {
  if (!state) return null;
  try {
    return await consume(state);
  } catch {
    return null;
  }
}
async function exchangeCodeForTokens(code, tenantId, existingEncryptedRefreshToken = null) {
  if (!code) throw new Error("Authorization code is required");
  const { client, clientId } = await oauth(tenantId);
  const { tokens } = await client.getToken(code);
  if (!tokens.access_token) throw new Error("Google did not return an access token");
  const encryptedRefreshToken = tokens.refresh_token
    ? encrypt(tokens.refresh_token)
    : existingEncryptedRefreshToken;
  if (!encryptedRefreshToken) {
    throw new Error("Google did not return a refresh token; reconnect with offline access");
  }

  let googleEmail = "";
  let googleAccountId = "";
  let googleName = "";
  let googlePicture = "";

  if (tokens.id_token) {
    try {
      // Identity metadata is display-only, but it still must come from a
      // signature-, issuer-, audience-, and expiry-verified Google ID token.
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
      const decoded = ticket.getPayload();
      if (decoded) {
        googleEmail = decoded.email || "";
        googleAccountId = decoded.sub || "";
        googleName = decoded.name || "";
        googlePicture = decoded.picture || "";
      }
    } catch (e) {
      logger.warn("google.id_token.verify.failed", { error: e.message });
      throw new Error("Google identity token verification failed");
    }
  }

  return {
    accessToken: encrypt(tokens.access_token),
    refreshToken: encryptedRefreshToken,
    tokenExpiresAt: new Date(tokens.expiry_date || Date.now() + Number(tokens.expires_in || 3600) * 1000),
    googleEmail,
    googleAccountId,
    googleName,
    googlePicture,
  };
}
async function connectFromCallback(code, state) {
  const tx = await consume(state);
  const existing = await GoogleConnection.findOne({ tenantId: tx.tenantId, userId: tx.userId }).select("+refreshToken");
  const token = await exchangeCodeForTokens(code, tx.tenantId, existing?.refreshToken || null);
  const saved = await GoogleConnection.findOneAndUpdate(
    { tenantId: tx.tenantId, userId: tx.userId },
    { tenantId: tx.tenantId, userId: tx.userId, ...token, status: "connected", connectedAt: new Date() },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return { userId: tx.userId, tenantId: tx.tenantId, connection: saved, returnTo: tx.returnTo };
}
async function connection(user) {
  if (!user?._id) throw new Error("User authentication required");
  if (GoogleConnection.db.readyState !== 1) {
    throw new Error("Database connection is required for Google Business Profile integration");
  }
  return GoogleConnection.findOne({
    tenantId: user.tenantId || user._id,
    userId: user._id,
  }).select("+accessToken +refreshToken");
}

function isRevokedTokenError(error) {
  const status = error.response?.status;
  const providerCode = error.response?.data?.error || error.code;
  return status === 401 || providerCode === "invalid_grant";
}

async function getValidAccessToken(user) {
  const current = await connection(user);
  if (!current || current.status === "revoked") {
    throw new Error("Google Business Profile is not connected; reconnect is required");
  }
  if (
    current.accessToken
    && current.tokenExpiresAt
    && new Date(current.tokenExpiresAt).getTime() - Date.now() > 300000
  ) {
    return decrypt(current.accessToken);
  }

  try {
    const refresh = decrypt(current.refreshToken);
    const { client } = await oauth(user.tenantId || user._id);
    client.setCredentials({ refresh_token: refresh });
    const { credentials } = await client.refreshAccessToken();
    if (!credentials.access_token) throw new Error("Google did not return a refreshed access token");
    current.accessToken = encrypt(credentials.access_token);
    current.tokenExpiresAt = new Date(
      credentials.expiry_date || Date.now() + Number(credentials.expires_in || 3600) * 1000
    );
    if (credentials.refresh_token) current.refreshToken = encrypt(credentials.refresh_token);
    current.status = "connected";
    await current.save();
    return credentials.access_token;
  } catch (error) {
    if (isRevokedTokenError(error)) {
      current.status = "revoked";
      await current.save();
    }
    logger.error("google.token.refresh.failed", {
      userId: user._id,
      tenantId: user.tenantId,
      revoked: isRevokedTokenError(error),
      error: error.message,
    });
    throw new Error(
      isRevokedTokenError(error)
        ? "Google authorization was revoked; reconnect is required"
        : "Google token refresh failed; try again"
    );
  }
}
function normalizeLocation(location = {}) {
  const a = location.storefrontAddress || {};
  const lines = Array.isArray(a.addressLines) ? a.addressLines.join(", ") : "";
  const additionalCategories = Array.isArray(location.categories?.additionalCategories)
    ? location.categories.additionalCategories.map((c) => c.displayName).filter(Boolean)
    : [];
  const additionalPhones = Array.isArray(location.phoneNumbers?.additionalPhones)
    ? location.phoneNumbers.additionalPhones.filter(Boolean)
    : [];
  return {
    businessId: location.name || "",
    accountName: location.accountName || "",
    businessName: location.title || "",
    category: location.categories?.primaryCategory?.displayName || "",
    additionalCategories,
    address: {
      streetName: lines,
      city: a.locality || "",
      state: a.administrativeArea || "",
      pincode: a.postalCode || "",
      country: a.regionCode || "",
      formattedAddress: [lines, a.locality, a.administrativeArea, a.postalCode, a.regionCode].filter(Boolean).join(", "),
    },
    phoneNumber: location.phoneNumbers?.primaryPhone || "",
    additionalPhones,
    website: location.websiteUri || "",
    description: location.profile?.description || "",
    businessHours: { periods: location.regularHours?.periods || [] },
    locationDetails: { latitude: location.latlng?.latitude || 0, longitude: location.latlng?.longitude || 0 },
    mapsUri: location.metadata?.mapsUri || "",
    openStatus: location.openInfo?.status || "",
  };
}
const READ_MASK = "name,title,categories,storefrontAddress,phoneNumbers,websiteUri,profile,regularHours,latlng,metadata,openInfo";
async function fetchAllPages(url, { headers, params = {}, itemKey, pageSize }) {
  const items = [];
  const seenPageTokens = new Set();
  let pageToken;
  do {
    if (pageToken && seenPageTokens.has(pageToken)) {
      throw new Error("Google returned a repeated pagination token");
    }
    if (pageToken) seenPageTokens.add(pageToken);
    const response = await axios.get(url, {
      headers,
      params: { ...params, pageSize, ...(pageToken ? { pageToken } : {}) },
    });
    const data = response.data || {};
    items.push(...(Array.isArray(data[itemKey]) ? data[itemKey] : []));
    pageToken = data.nextPageToken || null;
  } while (pageToken);
  return items;
}

async function fetchAllProfilesForUser(user) {
  const token = await getValidAccessToken(user);
  const headers = { Authorization: `Bearer ${token}` };
  const accounts = await fetchAllPages(
    "https://mybusinessaccountmanagement.googleapis.com/v1/accounts",
    { headers, itemKey: "accounts", pageSize: 20 }
  );
  const byLocationName = new Map();
  for (const account of accounts) {
    if (!/^accounts\/[A-Za-z0-9_-]+$/.test(account.name || "")) continue;
    const locations = await fetchAllPages(
      `https://mybusinessbusinessinformation.googleapis.com/v1/${account.name}/locations`,
      { headers, params: { readMask: READ_MASK }, itemKey: "locations", pageSize: 100 }
    );
    for (const location of locations) {
      const normalized = normalizeLocation({ ...location, accountName: account.name });
      if (normalized.businessId && !byLocationName.has(normalized.businessId)) {
        byLocationName.set(normalized.businessId, normalized);
      }
    }
  }
  return [...byLocationName.values()];
}
async function fetchProfileByLocationName(user, name) {
  if (!/^locations\/[A-Za-z0-9_-]+$/.test(name || "")) throw new Error("Invalid location ID");
  const token = await getValidAccessToken(user);
  const response = await axios.get(
    `https://mybusinessbusinessinformation.googleapis.com/v1/${name}`,
    { headers: { Authorization: `Bearer ${token}` }, params: { readMask: READ_MASK } }
  );
  return normalizeLocation(response.data);
}

/**
 * Best-effort, read-only fetch of a location's media (logo + photos) via the legacy
 * v4 Business Information API, which is still the only Google-official surface for
 * media on a Business Profile location. Never throws: any failure (missing scope,
 * API not enabled, rate limit) yields an empty result so an import never fails over
 * a photo fetch alone.
 */
async function fetchLocationMedia(user, accountName, locationName) {
  const empty = { logoUrl: null, photoUrls: [], accountVerified: false };
  if (!/^accounts\/[A-Za-z0-9_-]+$/.test(accountName || "") || !/^locations\/[A-Za-z0-9_-]+$/.test(locationName || "")) {
    return empty;
  }
  try {
    const token = await getValidAccessToken(user);
    const data = (await axios.get(
      `https://mybusiness.googleapis.com/v4/${accountName}/${locationName}/media`,
      { headers: { Authorization: `Bearer ${token}` }, params: { pageSize: 20 } }
    )).data;
    const items = Array.isArray(data.mediaItems)
      ? data.mediaItems
      : Array.isArray(data.mediaItem)
        ? data.mediaItem
        : [];
    let logoUrl = null;
    const photoUrls = [];
    for (const item of items) {
      const url = item.googleUrl;
      if (!url) continue;
      const category = item.locationAssociation?.category;
      if (!logoUrl && (category === "PROFILE" || category === "LOGO" || category === "COVER")) {
        logoUrl = url;
      } else if (photoUrls.length < 5) {
        photoUrls.push(url);
      }
    }
    return { logoUrl, photoUrls, accountVerified: true };
  } catch (error) {
    logger.warn("google.media.fetch_failed", { userId: user?._id, accountName, locationName, error: error.message });
    return empty;
  }
}

function assertReadOnly(operation) {
  if (operation && /patch|put|post|delete|update|create/i.test(operation)) {
    throw new Error(`Read-only violation: ${operation}`);
  }
  return true;
}

module.exports = {
  READ_ONLY,
  assertReadOnly,
  createAuthorizationRequest,
  cancelAuthorizationRequest,
  connectFromCallback,
  exchangeCodeForTokens,
  getValidAccessToken,
  normalizeLocation,
  fetchAllPages,
  fetchAllProfilesForUser,
  fetchProfileByLocationName,
  fetchLocationMedia,
  connection,
};
