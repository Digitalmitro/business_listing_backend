"use strict";

const axios = require("axios");
const crypto = require("node:crypto");
const logger = require("../utils/logger");
const { encrypt, decrypt } = require("../utils/cryptoUtils");
const SocialConnection = require("../models/SocialConnection");
const OAuthState = require("../models/OAuthState");
const TenantSocialCredential = require("../models/TenantSocialCredential");
const GoogleBusinessConnection = require("../models/GoogleBusinessConnection");

const SUPPORTED_PLATFORMS = Object.freeze({
  facebook: {
    name: "Facebook Pages",
    authUrl: "https://www.facebook.com/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/oauth/access_token",
    scopes: ["public_profile", "pages_show_list", "pages_read_engagement", "pages_manage_posts"],
    scopeSeparator: ",",
    credentialHelp: "Use the Meta App ID and App Secret. Publishing targets a managed Facebook Page.",
  },
  instagram: {
    name: "Instagram",
    authUrl: "https://www.instagram.com/oauth/authorize",
    tokenUrl: "https://api.instagram.com/oauth/access_token",
    scopes: ["instagram_business_basic", "instagram_business_content_publish"],
    scopeSeparator: ",",
    credentialHelp: "Use the Instagram App ID and App Secret for Instagram Login. A professional account is required.",
  },
  threads: {
    name: "Threads",
    authUrl: "https://threads.net/oauth/authorize",
    tokenUrl: "https://graph.threads.net/oauth/access_token",
    scopes: ["threads_basic", "threads_content_publish"],
    scopeSeparator: ",",
    credentialHelp: "Use the Threads App ID and Threads App Secret from the Meta application.",
  },
  linkedin: {
    name: "LinkedIn",
    authUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    scopes: ["openid", "profile", "email", "w_member_social"],
    credentialHelp: "Use the LinkedIn OAuth Client ID and Client Secret with the Share on LinkedIn product approved.",
  },
  twitter: {
    name: "X",
    authUrl: "https://x.com/i/oauth2/authorize",
    tokenUrl: "https://api.x.com/2/oauth2/token",
    scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
    credentialHelp: "Use the OAuth 2.0 Client ID and Client Secret, not the API consumer key or app-only bearer token.",
  },
  pinterest: {
    name: "Pinterest",
    authUrl: "https://www.pinterest.com/oauth/",
    tokenUrl: "https://api.pinterest.com/v5/oauth/token",
    scopes: ["user_accounts:read", "boards:read", "pins:read", "pins:write"],
    scopeSeparator: ",",
    credentialHelp: "Use the Pinterest App ID and App Secret. Publishing requires a selected board and public image URL.",
  },
});

const BUFFER_MS = 5 * 60 * 1000;
const LINKEDIN_API_VERSION = process.env.LINKEDIN_API_VERSION || "202601";

class RevokedPermissionError extends Error {
  constructor(platform, message) {
    super(`Permissions for ${platform} have been revoked or expired: ${message}`);
    this.name = "RevokedPermissionError";
    this.platform = platform;
    this.status = "revoked";
  }
}

function getPlatformConfig(platform) {
  const normalized = String(platform || "").toLowerCase();
  const config = SUPPORTED_PLATFORMS[normalized];
  if (!config) throw new Error(`Unsupported social media platform: '${platform}'`);
  return { ...config, platform: normalized };
}

function tenantIdForUser(user) {
  const tenantId = user?.tenantId || user?._id;
  if (!tenantId || !user?._id) throw new Error("Tenant context is required");
  return tenantId;
}

function getEnvCredentials(platform) {
  const envPrefix = String(platform).toUpperCase();
  const id = process.env[`${envPrefix}_CLIENT_ID`] || process.env[`${envPrefix}_APP_ID`];
  const secret = process.env[`${envPrefix}_CLIENT_SECRET`] || process.env[`${envPrefix}_APP_SECRET`];
  const redirectUri = process.env[`${envPrefix}_REDIRECT_URI`] || `${process.env.BACKEND_URL || "http://localhost:8000"}/api/social-integrations/callback/${platform}`;
  if (id && secret) {
    return { id: String(id).trim(), secret: String(secret).trim(), redirectUri: String(redirectUri).trim() };
  }
  return null;
}

async function credentials(tenantId, config) {
  const stored = await TenantSocialCredential.findOne({
    tenantId,
    platform: config.platform,
    enabled: true,
  }).select("+clientId +clientSecret");

  if (stored) {
    const id = decrypt(stored.clientId);
    const secret = decrypt(stored.clientSecret);
    const redirectUri = stored.redirectUri;
    if (!id || !secret || !redirectUri) throw new Error(`${config.name} has incomplete OAuth configuration`);
    if (process.env.NODE_ENV === "production" && !/^https:\/\//i.test(redirectUri)) {
      throw new Error(`${config.name} redirect URI must use HTTPS in production`);
    }
    return { id, secret, redirectUri };
  }

  const envCred = getEnvCredentials(config.platform);
  if (envCred) {
    if (process.env.NODE_ENV === "production" && !/^https:\/\//i.test(envCred.redirectUri)) {
      throw new Error(`${config.name} redirect URI must use HTTPS in production`);
    }
    return envCred;
  }

  throw new Error(`${config.name} is not configured for this tenant`);
}

function buildAuthorizationUrl(config, credential, state, codeChallenge) {
  if (!state) throw new Error("OAuth state is required");
  const params = new URLSearchParams({
    client_id: credential.id,
    redirect_uri: credential.redirectUri,
    response_type: "code",
    scope: config.scopes.join(config.scopeSeparator || " "),
    state,
  });
  if (config.platform === "facebook") {
    params.set("auth_type", "rerequest");
  }
  if (codeChallenge) {
    params.set("code_challenge", codeChallenge);
    params.set("code_challenge_method", "S256");
  }
  return `${config.authUrl}?${params.toString()}`;
}

async function getAuthUrl(platform, state, tenantId, redirectUri, codeChallenge) {
  const config = getPlatformConfig(platform);
  const credential = await credentials(tenantId, config);
  if (redirectUri && redirectUri !== credential.redirectUri) throw new Error("redirect URI cannot be overridden");
  return buildAuthorizationUrl(config, credential, state, codeChallenge);
}

function createPkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function redact(connection) {
  const providerData = connection.providerData || {};
  return {
    platform: connection.platform,
    status: connection.status,
    isConnected: connection.status === "connected",
    providerAccountId: connection.providerAccountId,
    providerUsername: connection.providerUsername,
    platformUsername: connection.providerUsername,
    profileName: connection.profileName,
    profileImageUrl: connection.profileImageUrl,
    scopes: connection.scopes,
    connectedAt: connection.connectedAt,
    tokenExpiresAt: connection.tokenExpiresAt,
    providerData: {
      pages: (providerData.pages || []).map((page) => ({
        id: page.id,
        name: page.name,
        image: page.picture?.data?.url || page.image || "",
      })),
      boards: (providerData.boards || []).map((board) => ({ id: board.id, name: board.name })),
    },
  };
}

async function createAuthorizationRequest(user, platform, returnTo) {
  const config = getPlatformConfig(platform);
  const tenantId = tenantIdForUser(user);
  const credential = await credentials(tenantId, config);
  const state = crypto.randomBytes(32).toString("hex");
  const stateHash = crypto.createHash("sha256").update(state).digest("hex");
  const pkce = config.platform === "twitter" ? createPkce() : { verifier: null, challenge: null };

  await OAuthState.create({
    userId: user._id,
    tenantId,
    platform: config.platform,
    stateHash,
    codeVerifier: pkce.verifier,
    redirectUri: credential.redirectUri,
    returnTo: returnTo || "/settings/integrations",
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });
  return buildAuthorizationUrl(config, credential, state, pkce.challenge);
}

async function consumeState(platform, state) {
  if (!state) throw new Error("Missing OAuth state");
  const stateHash = crypto.createHash("sha256").update(state).digest("hex");
  const record = await OAuthState.findOneAndDelete({
    platform,
    stateHash,
    expiresAt: { $gt: new Date() },
  });
  if (!record) throw new Error("Invalid or expired OAuth state");
  return record;
}

async function tokenRequest(config, body, codeVerifier, credential) {
  const params = new URLSearchParams({ ...body, client_id: credential.id });
  if (body.grant_type === "authorization_code") params.set("redirect_uri", credential.redirectUri);
  if (codeVerifier) params.set("code_verifier", codeVerifier);
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };

  if (config.platform === "pinterest" || config.platform === "twitter") {
    headers.Authorization = `Basic ${Buffer.from(`${credential.id}:${credential.secret}`).toString("base64")}`;
  } else {
    params.set("client_secret", credential.secret);
  }
  const response = await axios.post(config.tokenUrl, params.toString(), { headers, timeout: 15_000 });
  return response.data;
}

async function exchangeForLongLivedToken(config, data, credential) {
  if (!data.access_token) return data;
  if (config.platform === "facebook") {
    const response = await axios.get("https://graph.facebook.com/oauth/access_token", {
      params: {
        grant_type: "fb_exchange_token",
        client_id: credential.id,
        client_secret: credential.secret,
        fb_exchange_token: data.access_token,
      },
      timeout: 15_000,
    });
    return { ...data, ...response.data };
  }
  if (config.platform === "instagram" || config.platform === "threads") {
    const host = config.platform === "threads" ? "https://graph.threads.net/access_token" : "https://graph.instagram.com/access_token";
    const grantType = config.platform === "threads" ? "th_exchange_token" : "ig_exchange_token";
    const response = await axios.get(host, {
      params: { grant_type: grantType, client_secret: credential.secret, access_token: data.access_token },
      timeout: 15_000,
    });
    return { ...data, ...response.data };
  }
  return data;
}

async function apiGet(url, token, params) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await axios.get(url, {
    headers,
    params,
    timeout: 15_000,
  });
  return response.data;
}

async function profileFor(config, token, credential) {
  if (config.platform === "linkedin") {
    const profile = await apiGet("https://api.linkedin.com/v2/userinfo", token);
    return { id: profile.sub, username: profile.email || "", name: profile.name, image: profile.picture };
  }
  if (config.platform === "twitter") {
    const profile = await apiGet("https://api.x.com/2/users/me", token, { "user.fields": "profile_image_url,username,name" });
    return { id: profile.data.id, username: profile.data.username, name: profile.data.name, image: profile.data.profile_image_url };
  }
  if (config.platform === "pinterest") {
    const profile = await apiGet("https://api.pinterest.com/v5/user_account", token);
    return { id: profile.username, username: profile.username, name: profile.business_name || profile.username, image: profile.profile_image };
  }
  if (config.platform === "threads") {
    const profile = await apiGet("https://graph.threads.net/v1.0/me", token, {
      fields: "id,username,threads_profile_picture_url",
    });
    return { id: profile.id, username: profile.username, name: profile.username, image: profile.threads_profile_picture_url };
  }
  if (config.platform === "instagram") {
    const profile = await apiGet("https://graph.instagram.com/me", token, {
      fields: "user_id,username,name,profile_picture_url",
    });
    return { id: profile.user_id || profile.id, username: profile.username, name: profile.name || profile.username, image: profile.profile_picture_url };
  }
  const [me, pagesRes] = await Promise.all([
    apiGet("https://graph.facebook.com/me", token, { fields: "id,name" }),
    apiGet("https://graph.facebook.com/me/accounts", token, { fields: "id,name,access_token,picture", limit: 100 }).catch(() => ({ data: [] })),
  ]);

  let pages = pagesRes.data || [];

  // Fallback for Meta Granular Consent (New Pages Experience) when /me/accounts returns empty
  if (pages.length === 0 && credential?.id && credential?.secret) {
    try {
      const appToken = `${credential.id}|${credential.secret}`;
      const debugRes = await apiGet("https://graph.facebook.com/debug_token", null, {
        input_token: token,
        access_token: appToken,
      });
      const targetIds = new Set();
      (debugRes.data?.granular_scopes || []).forEach((gs) => {
        (gs.target_ids || []).forEach((id) => targetIds.add(id));
      });
      for (const targetId of targetIds) {
        try {
          const pageData = await apiGet(`https://graph.facebook.com/${targetId}`, token, {
            fields: "id,name,picture,access_token",
          });
          if (pageData && pageData.id) {
            pages.push({
              id: pageData.id,
              name: pageData.name || "Facebook Page",
              picture: pageData.picture,
              access_token: pageData.access_token || token,
            });
          }
        } catch (e) { }
      }
    } catch (e) { }
  }

  return { id: String(me.id || ""), username: "", name: me.name || "", image: "", pages };
}

async function exchangeCodeAndFetchProfile(platform, code, redirectUri, codeVerifier, tenantId) {
  const config = getPlatformConfig(platform);
  const credential = await credentials(tenantId, config);
  if (redirectUri && redirectUri !== credential.redirectUri) throw new Error("redirect URI cannot be overridden");
  if (!code) throw new Error("Authorization code is required");

  let data = await tokenRequest(config, { code, grant_type: "authorization_code" }, codeVerifier, credential);
  data = await exchangeForLongLivedToken(config, data, credential);
  if (!data.access_token) throw new Error(`${config.name} did not return an access token`);
  const profile = await profileFor(config, data.access_token, credential);
  if (!profile.id) throw new Error(`${config.name} did not return an account identifier`);

  return {
    status: "connected",
    providerAccountId: profile.id,
    providerUsername: profile.username || "",
    profileName: profile.name || "",
    profileImageUrl: profile.image || "",
    accessToken: encrypt(data.access_token),
    refreshToken: data.refresh_token ? encrypt(data.refresh_token) : null,
    tokenExpiresAt: data.expires_in ? new Date(Date.now() + Number(data.expires_in) * 1000) : null,
    refreshTokenExpiresAt: data.refresh_token_expires_in ? new Date(Date.now() + Number(data.refresh_token_expires_in) * 1000) : null,
    connectedAt: new Date(),
    scopes: String(data.scope || config.scopes.join(" ")).split(/[ ,]+/).filter(Boolean),
    providerData: {
      pages: (profile.pages || []).map((page) => ({ ...page, access_token: encrypt(page.access_token) })),
    },
  };
}

async function connectFromCallback(platform, code, state) {
  const config = getPlatformConfig(platform);
  const transaction = await consumeState(config.platform, state);
  const account = await exchangeCodeAndFetchProfile(
    config.platform,
    code,
    transaction.redirectUri,
    transaction.codeVerifier,
    transaction.tenantId
  );
  const saved = await SocialConnection.findOneAndUpdate(
    { tenantId: transaction.tenantId, userId: transaction.userId, platform: config.platform },
    {
      ...account,
      tenantId: transaction.tenantId,
      userId: transaction.userId,
      platform: config.platform,
      lastError: null,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  if (config.platform === "pinterest") {
    try {
      const boards = await apiGet("https://api.pinterest.com/v5/boards", decrypt(saved.accessToken));
      saved.providerData = {
        ...(saved.providerData || {}),
        boards: (boards.items || []).map((board) => ({ id: board.id, name: board.name })),
      };
      await saved.save();
    } catch (error) {
      logger.warn("pinterest.boards.fetch.failed", {
        userId: transaction.userId,
        tenantId: transaction.tenantId,
        error: error.message,
      });
    }
  }
  return { userId: transaction.userId, tenantId: transaction.tenantId, account: saved, returnTo: transaction.returnTo };
}

async function findConnection(user, platform) {
  const normalized = getPlatformConfig(platform).platform;
  const tenantId = tenantIdForUser(user);
  if (SocialConnection.db.readyState !== 1) throw new Error("Database connection is required for social integrations");
  return SocialConnection.findOne({ tenantId, userId: user._id, platform: normalized })
    .select("+accessToken +refreshToken +providerData");
}

async function saveConnection(connection) {
  if (connection && typeof connection.save === "function") await connection.save();
}

async function refreshLongLivedMetaToken(config, account) {
  const accessToken = decrypt(account.accessToken);
  const endpoint = config.platform === "threads"
    ? "https://graph.threads.net/refresh_access_token"
    : "https://graph.instagram.com/refresh_access_token";
  const grantType = config.platform === "threads" ? "th_refresh_token" : "ig_refresh_token";
  const response = await axios.get(endpoint, {
    params: { grant_type: grantType, access_token: accessToken },
    timeout: 15_000,
  });
  return response.data;
}

async function getValidAccessToken(user, platform) {
  const config = getPlatformConfig(platform);
  const account = await findConnection(user, config.platform);
  if (!account || account.status !== "connected") throw new Error(`Account ${config.name} is not connected`);
  const expiry = account.tokenExpiresAt;
  if (account.accessToken && (!expiry || new Date(expiry).getTime() - Date.now() > BUFFER_MS)) {
    return decrypt(account.accessToken);
  }

  if (!account.refreshToken && !["instagram", "threads"].includes(config.platform)) {
    account.status = "expired";
    await saveConnection(account);
    throw new Error(`Access token for ${config.name} expired; reconnect is required`);
  }

  try {
    const credential = await credentials(tenantIdForUser(user), config);
    const data = ["instagram", "threads"].includes(config.platform)
      ? await refreshLongLivedMetaToken(config, account)
      : await tokenRequest(config, {
        grant_type: "refresh_token",
        refresh_token: decrypt(account.refreshToken),
      }, null, credential);
    if (!data.access_token) throw new Error("refresh response missing access token");
    account.accessToken = encrypt(data.access_token);
    if (data.refresh_token) account.refreshToken = encrypt(data.refresh_token);
    account.tokenExpiresAt = new Date(Date.now() + Number(data.expires_in || 3600) * 1000);
    account.status = "connected";
    account.lastError = null;
    await saveConnection(account);
    return data.access_token;
  } catch (error) {
    account.status = /401|403|invalid_grant|authentication failed/i.test(error.message) ? "revoked" : "expired";
    account.lastError = error.message;
    await saveConnection(account);
    throw new RevokedPermissionError(config.platform, "refresh failed; reconnect is required");
  }
}

async function disconnectAccount(user, platform) {
  const config = getPlatformConfig(platform);
  const tenantId = tenantIdForUser(user);
  if (SocialConnection.db.readyState !== 1) throw new Error("Database connection is required for social integrations");
  await SocialConnection.deleteOne({ tenantId, userId: user._id, platform: config.platform });
}

async function listAccounts(user) {
  const tenantId = tenantIdForUser(user);
  if (SocialConnection.db.readyState !== 1) throw new Error("Database connection is required for social integrations");
  const rows = await SocialConnection.find({ tenantId, userId: user._id }).select("+providerData");
  const byPlatform = new Map(rows.map((row) => [row.platform, row]));
  return Object.fromEntries(Object.keys(SUPPORTED_PLATFORMS).map((platform) => {
    const account = byPlatform.get(platform);
    return [platform, account ? redact(account) : { platform, status: "not_connected", isConnected: false }];
  }));
}

async function listTenantCredentials(user) {
  const tenantId = tenantIdForUser(user);
  const rows = await TenantSocialCredential.find({ tenantId })
    .select("platform redirectUri enabled updatedAt")
    .lean();
  const byPlatform = new Map(rows.map((row) => [row.platform, row]));
  const platforms = [...Object.keys(SUPPORTED_PLATFORMS), "google_business"];
  return platforms.map((platform) => {
    const row = byPlatform.get(platform);
    const config = platform === "google_business"
      ? { name: "Google Business Profile", credentialHelp: "Use a Web application OAuth client with the business.manage scope." }
      : SUPPORTED_PLATFORMS[platform];
    const envCred = getEnvCredentials(platform);
    const configured = Boolean(row?.enabled) || Boolean(envCred);
    return {
      platform,
      displayName: config.name,
      configured,
      redirectUri: row?.redirectUri || envCred?.redirectUri || null,
      updatedAt: row?.updatedAt || null,
      credentialHelp: config.credentialHelp,
    };
  });
}

async function saveTenantCredential(user, platform, input = {}) {
  const tenantId = tenantIdForUser(user);
  const normalized = platform === "google" ? "google_business" : String(platform || "").toLowerCase();
  if (normalized !== "google_business") getPlatformConfig(normalized);
  const clientId = String(input.clientId || "").trim();
  const clientSecret = String(input.clientSecret || "").trim();
  const redirectUri = String(input.redirectUri || "").trim();
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("clientId, clientSecret, and redirectUri are required");
  }
  let parsed;
  try {
    parsed = new URL(redirectUri);
  } catch {
    throw new Error("redirectUri must be a valid absolute URL");
  }
  if (!["https:", "http:"].includes(parsed.protocol)) throw new Error("redirectUri must use HTTP or HTTPS");
  if (process.env.NODE_ENV === "production" && parsed.protocol !== "https:") {
    throw new Error("redirectUri must use HTTPS in production");
  }
  return TenantSocialCredential.findOneAndUpdate(
    { tenantId, platform: normalized },
    {
      tenantId,
      platform: normalized,
      clientId: encrypt(clientId),
      clientSecret: encrypt(clientSecret),
      redirectUri,
      enabled: true,
      createdBy: user._id,
      updatedBy: user._id,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
  ).select("platform redirectUri enabled updatedAt");
}

async function deleteTenantCredential(user, platform) {
  const tenantId = tenantIdForUser(user);
  const normalized = platform === "google" ? "google_business" : String(platform || "").toLowerCase();
  if (![...Object.keys(SUPPORTED_PLATFORMS), "google_business"].includes(normalized)) {
    throw new Error("Unsupported integration platform");
  }
  await TenantSocialCredential.deleteOne({ tenantId, platform: normalized });
  await OAuthState.deleteMany({ tenantId, platform: normalized });
  if (normalized === "google_business") {
    await GoogleBusinessConnection.deleteMany({ tenantId });
  } else {
    await SocialConnection.deleteMany({ tenantId, platform: normalized });
  }
}

function retryable(error) {
  return [408, 429, 500, 502, 503, 504].includes(error.response?.status);
}

async function requestWithRetry(operation, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!retryable(error) || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
    }
  }
  throw lastError;
}

async function publishThreads(account, token, postData) {
  const text = String(postData.text || "").trim();
  const body = { text, access_token: token };
  if (postData.videoUrl) {
    body.media_type = "VIDEO";
    body.video_url = postData.videoUrl;
  } else if (postData.imageUrl) {
    body.media_type = "IMAGE";
    body.image_url = postData.imageUrl;
  } else {
    body.media_type = "TEXT";
  }
  const container = await requestWithRetry(() => axios.post(
    `https://graph.threads.net/v1.0/${account.providerAccountId}/threads`,
    body,
    { timeout: 15_000 }
  ));
  return requestWithRetry(() => axios.post(
    `https://graph.threads.net/v1.0/${account.providerAccountId}/threads_publish`,
    { creation_id: container.data.id, access_token: token },
    { timeout: 15_000 }
  ));
}

async function publishLinkedIn(account, token, postData) {
  const text = String(postData.text || "").trim();
  const headers = {
    Authorization: `Bearer ${token}`,
    "LinkedIn-Version": LINKEDIN_API_VERSION,
    "X-Restli-Protocol-Version": "2.0.0",
    "Content-Type": "application/json",
  };

  const payload = {
    author: `urn:li:person:${account.providerAccountId}`,
    commentary: text,
    visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: "PUBLISHED",
  };

  if (postData.imageUrl) {
    try {
      const initRes = await requestWithRetry(() => axios.post(
        "https://api.linkedin.com/rest/images?action=initializeUpload",
        { initializeUploadRequest: { owner: `urn:li:person:${account.providerAccountId}` } },
        { headers, timeout: 15_000 }
      ));

      const { uploadUrl, image } = initRes.data?.value || {};
      if (uploadUrl && image) {
        const imgBuffer = (await axios.get(postData.imageUrl, { responseType: "arraybuffer", timeout: 15_000 })).data;
        await axios.put(uploadUrl, imgBuffer, { headers: { "Content-Type": "image/jpeg" }, timeout: 20_000 });
        payload.content = { media: { id: image, title: text.slice(0, 100) || "Image" } };
      }
    } catch (err) {
      logger.warn("linkedin.image_upload.fallback", { error: err.message });
      payload.content = {
        article: {
          source: postData.imageUrl,
          title: text.slice(0, 100) || "Post Image",
          description: text || "Image shared via UrbanCitations",
        },
      };
    }
  }

  const response = await requestWithRetry(() => axios.post(
    "https://api.linkedin.com/rest/posts",
    payload,
    { headers, timeout: 15_000 }
  ));

  return {
    ...response,
    postId: response.headers?.["x-restli-id"] || response.data?.id || `urn:li:share:${Date.now()}`,
  };
}

async function verifyOrPostToPlatform(user, platform, postData = {}) {
  const config = getPlatformConfig(platform);
  const account = await findConnection(user, config.platform);
  const token = await getValidAccessToken(user, config.platform);
  const text = String(postData.text || "").trim();
  if (!text && !postData.imageUrl && !postData.videoUrl) {
    throw new Error("Post must contain text or supported media");
  }

  let response;
  try {
    if (config.platform === "facebook") {
      const page = (account.providerData?.pages || []).find((item) => String(item.id) === String(postData.pageId));
      if (!page?.access_token) throw new Error("Select a connected Facebook Page before posting");
      const pageAccessToken = decrypt(page.access_token);
      if (postData.videoUrl) {
        response = await requestWithRetry(() => axios.post(
          `https://graph.facebook.com/${page.id}/videos`,
          { file_url: postData.videoUrl, description: text, access_token: pageAccessToken },
          { timeout: 15_000 }
        ));
      } else if (postData.imageUrl) {
        response = await requestWithRetry(() => axios.post(
          `https://graph.facebook.com/${page.id}/photos`,
          { url: postData.imageUrl, caption: text, access_token: pageAccessToken },
          { timeout: 15_000 }
        ));
      } else {
        response = await requestWithRetry(() => axios.post(
          `https://graph.facebook.com/${page.id}/feed`,
          { message: text, link: postData.linkUrl },
          { params: { access_token: pageAccessToken }, timeout: 15_000 }
        ));
      }
    } else if (config.platform === "instagram") {
      if (!postData.imageUrl && !postData.videoUrl) {
        throw new Error("Instagram publishing requires a public image or video URL");
      }
      const container = await requestWithRetry(() => axios.post(
        `https://graph.instagram.com/${account.providerAccountId}/media`,
        {
          image_url: postData.imageUrl || undefined,
          video_url: postData.videoUrl || undefined,
          caption: text,
          media_type: postData.videoUrl ? "REELS" : "IMAGE",
          access_token: token,
        },
        { timeout: 15_000 }
      ));
      response = await requestWithRetry(() => axios.post(
        `https://graph.instagram.com/${account.providerAccountId}/media_publish`,
        { creation_id: container.data.id, access_token: token },
        { timeout: 15_000 }
      ));
    } else if (config.platform === "threads") {
      response = await publishThreads(account, token, postData);
    } else if (config.platform === "linkedin") {
      response = await publishLinkedIn(account, token, postData);
    } else if (config.platform === "twitter") {
      let tweetText = text;
      if (postData.imageUrl) {
        tweetText = tweetText ? `${tweetText}\n\n${postData.imageUrl}` : postData.imageUrl;
      } else if (postData.videoUrl) {
        tweetText = tweetText ? `${tweetText}\n\n${postData.videoUrl}` : postData.videoUrl;
      }
      response = await requestWithRetry(() => axios.post(
        "https://api.x.com/2/tweets",
        { text: tweetText.trim() },
        { headers: { Authorization: `Bearer ${token}` }, timeout: 15_000 }
      ));
    } else if (config.platform === "pinterest") {
      if (!postData.boardId || !postData.imageUrl) {
        throw new Error("Pinterest publishing requires a selected board and public image URL");
      }
      response = await requestWithRetry(() => axios.post(
        "https://api.pinterest.com/v5/pins",
        {
          board_id: postData.boardId,
          description: text,
          media_source: { source_type: "image_url", url: postData.imageUrl },
        },
        { headers: { Authorization: `Bearer ${token}` }, timeout: 15_000 }
      ));
    }
    return {
      success: true,
      platform: config.platform,
      platformName: config.name,
      postId: response.data?.id || response.data?.data?.id || response.headers?.["x-restli-id"],
      status: "published",
    };
  } catch (error) {
    logger.error("social.publish.failed", {
      userId: user?._id,
      tenantId: user?.tenantId,
      platform: config.platform,
      status: error.response?.status,
      error: error.message,
    });
    if ([401, 403].includes(error.response?.status)) {
      account.status = "revoked";
      await saveConnection(account);
      throw new RevokedPermissionError(config.platform, "provider rejected the request");
    }
    const providerMessage = error.response?.data?.error?.message || error.response?.data?.message || error.message;
    throw new Error(`Failed to publish to ${config.name}: ${providerMessage}`);
  }
}

module.exports = {
  SUPPORTED_PLATFORMS,
  RevokedPermissionError,
  getPlatformConfig,
  buildAuthorizationUrl,
  getAuthUrl,
  createAuthorizationRequest,
  connectFromCallback,
  exchangeCodeAndFetchProfile,
  getValidAccessToken,
  disconnectAccount,
  listAccounts,
  listTenantCredentials,
  saveTenantCredential,
  deleteTenantCredential,
  verifyOrPostToPlatform,
  redact,
};
