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
  // select_account: always let the owner pick which Google account manages the business
  // (it often differs from the UrbanCitations login and from the browser's default account).
  return client.generateAuthUrl({ access_type: "offline", prompt: "consent select_account", scope: SCOPES, state });
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
const BUSINESS_SCOPE = "https://www.googleapis.com/auth/business.manage";

/**
 * Turns an axios error from a Google Business Profile API call into an Error carrying
 * the HTTP status, a stable `code` and a message naming the real cause. Google answers
 * 403 both when the API is merely switched off in the Cloud project and when the user
 * unticked the permission on the consent screen, and 429 with a quota of 0 when the
 * project has not been approved, so the status alone cannot say which one happened.
 * Returns null when the error is not an HTTP error from Google.
 */
function toGoogleApiError(error) {
  const status = error?.response?.status;
  if (!status) return null;
  const body = error.response.data?.error || {};
  const details = Array.isArray(body.details) ? body.details : [];
  const info = details.find((d) => d && d.reason) || {};
  const meta = info.metadata || {};
  const reason = info.reason || body.errors?.[0]?.reason || body.status || "";
  const googleMessage = typeof body.message === "string" ? body.message : "";
  const project = String(meta.consumer || meta.containerInfo || "").replace(/^projects\//, "")
    || (googleMessage.match(/project[ _](?:number:)?(\d+)/i) || [])[1] || "";
  const service = meta.service || (googleMessage.match(/([a-z]+\.googleapis\.com)/) || [])[1] || "the Business Profile API";

  logger.error("google_business.api_error", { status, reason, service, project, googleMessage });

  const make = (httpStatus, code, message) => Object.assign(new Error(message), {
    status: httpStatus,
    code,
    googleReason: reason,
    googleMessage,
    googleStatus: status,
  });

  if (reason === "SERVICE_DISABLED" || reason === "accessNotConfigured" || /has not been used in project|is disabled/i.test(googleMessage)) {
    const where = meta.activationUrl || `https://console.cloud.google.com/apis/library/${service}${project ? `?project=${project}` : ""}`;
    return make(403, "api_disabled", `${service} is not enabled in this site's Google Cloud project${project ? ` (${project})` : ""}. Enable it at ${where} and try again in a few minutes.`);
  }
  if (reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT" || reason === "insufficientPermissions") {
    return make(401, "scope_missing", "Google did not grant permission to manage your Business Profile. Reconnect and keep the Business Profile permission ticked on Google's consent screen.");
  }
  if (status === 429) {
    const quotaZero = String(meta.quota_limit_value ?? "") === "0" || /limit '?0'?\b/i.test(googleMessage);
    if (quotaZero) {
      return make(403, "api_not_approved", `Google has not approved this site's Google Cloud project${project ? ` (${project})` : ""} for the Business Profile API yet (its quota is 0). Request access at https://developers.google.com/my-business/content/prereqs.`);
    }
    return make(429, "rate_limited", "Google API rate limit exceeded. Please wait a moment and try again.");
  }
  if (status === 401) {
    return make(401, "reconnect_required", "Google authorization expired or was revoked; reconnect is required");
  }
  if (status === 403) {
    return make(403, "google_forbidden", `Google refused the request${googleMessage ? `: ${googleMessage}` : "."}`);
  }
  return null;
}

async function exchangeCodeForTokens(code, tenantId, existingEncryptedRefreshToken = null) {
  if (!code) throw new Error("Authorization code is required");
  const { client, clientId } = await oauth(tenantId);
  const { tokens } = await client.getToken(code);
  if (!tokens.access_token) throw new Error("Google did not return an access token");
  // Google's granular consent lets the user untick Business Profile access; without it
  // every later Business Profile call fails with 403, so refuse the connection up front.
  if (typeof tokens.scope === "string" && !tokens.scope.split(/\s+/).includes(BUSINESS_SCOPE)) {
    throw Object.assign(new Error("Google Business Profile permission was not granted"), { code: "scope_missing" });
  }
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
  let token;
  try {
    token = await exchangeCodeForTokens(code, tx.tenantId, existing?.refreshToken || null);
  } catch (error) {
    error.returnTo = tx.returnTo; // so the callback can send the user back where they started
    throw error;
  }
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
      area: a.sublocality || "",
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
    openingYear: Number(location.openInfo?.openingDate?.year) || null,
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
  let firstAccountError = null;
  let readableAccounts = 0;
  for (const account of accounts) {
    if (!/^accounts\/[A-Za-z0-9_-]+$/.test(account.name || "")) continue;
    let locations;
    try {
      locations = await fetchAllPages(
        `https://mybusinessbusinessinformation.googleapis.com/v1/${account.name}/locations`,
        { headers, params: { readMask: READ_MASK }, itemKey: "locations", pageSize: 100 }
      );
      readableAccounts += 1;
    } catch (error) {
      // One account (e.g. a location group the user can't read) must not hide the
      // locations of every other account; fail only when no account is readable.
      const status = error.response?.status;
      if (status !== 403 && status !== 404) throw error;
      logger.warn("google_business.account_locations_unreadable", {
        account: account.name,
        type: account.type,
        role: account.role,
        status,
        googleMessage: error.response?.data?.error?.message,
      });
      firstAccountError = firstAccountError || error;
      continue;
    }
    for (const location of locations) {
      const normalized = normalizeLocation({ ...location, accountName: account.name });
      // The signed-in Google user's role on the account holding this location
      // (PRIMARY_OWNER, OWNER, MANAGER, SITE_MANAGER), used to gate ownership moves.
      normalized.accountRole = account.role || "";
      if (normalized.businessId && !byLocationName.has(normalized.businessId)) {
        byLocationName.set(normalized.businessId, normalized);
      }
    }
  }
  if (!readableAccounts && firstAccountError) throw firstAccountError;
  return [...byLocationName.values()];
}
const OWNER_ROLES = new Set(["PRIMARY_OWNER", "OWNER"]);

/**
 * True when the connected Google account is an Owner (not just a Manager) of the
 * account that holds this location, checked live against Google.
 */
async function isLocationOwner(user, locationName) {
  const profiles = await fetchAllProfilesForUser(user);
  const match = profiles.find((p) => p.businessId === locationName);
  return Boolean(match && OWNER_ROLES.has(match.accountRole));
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
 *
 * logoUrl is the LOGO image (else the PROFILE image); photoUrls lists the COVER image
 * first, then every other photo, up to MAX_MEDIA_PHOTOS. Videos are skipped.
 */
const MAX_MEDIA_PHOTOS = 50;
async function fetchLocationMedia(user, accountName, locationName) {
  const empty = { logoUrl: null, photoUrls: [], accountVerified: false };
  if (!/^accounts\/[A-Za-z0-9_-]+$/.test(accountName || "") || !/^locations\/[A-Za-z0-9_-]+$/.test(locationName || "")) {
    return empty;
  }
  try {
    const token = await getValidAccessToken(user);
    const items = [];
    let pageToken;
    do {
      const data = (await axios.get(
        `https://mybusiness.googleapis.com/v4/${accountName}/${locationName}/media`,
        { headers: { Authorization: `Bearer ${token}` }, params: { pageSize: 100, ...(pageToken ? { pageToken } : {}) } }
      )).data || {};
      items.push(...(Array.isArray(data.mediaItems) ? data.mediaItems : Array.isArray(data.mediaItem) ? data.mediaItem : []));
      pageToken = data.nextPageToken || null;
    } while (pageToken && items.length < MAX_MEDIA_PHOTOS * 2);

    const photos = items.filter((item) => item.googleUrl && (item.mediaFormat || "PHOTO") === "PHOTO");
    const byCategory = (category) => photos.find((item) => item.locationAssociation?.category === category);
    const logo = byCategory("LOGO") || byCategory("PROFILE");
    const cover = byCategory("COVER");
    const photoUrls = [...new Set([
      ...(cover ? [cover.googleUrl] : []),
      ...photos.filter((item) => item !== logo && item !== cover).map((item) => item.googleUrl),
    ])].slice(0, MAX_MEDIA_PHOTOS);
    return { logoUrl: logo ? logo.googleUrl : null, photoUrls, accountVerified: true };
  } catch (error) {
    logger.warn("google.media.fetch_failed", { userId: user?._id, accountName, locationName, error: error.message, googleMessage: error.response?.data?.error?.message });
    // Photos come from the v4 API (mybusiness.googleapis.com), which Google unlocks separately
    // from the profile APIs; the caller still imports the details and reports this reason.
    const apiError = toGoogleApiError(error);
    return { ...empty, mediaError: apiError?.code || "media_unavailable" };
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
  toGoogleApiError,
  fetchAllPages,
  fetchAllProfilesForUser,
  fetchProfileByLocationName,
  isLocationOwner,
  OWNER_ROLES,
  fetchLocationMedia,
  connection,
};
