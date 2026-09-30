"use strict";

const axios = require("axios");
const logger = require("../utils/logger");
const googleBusinessService = require("./googleBusinessService");
const GoogleConnection = require("../models/GoogleBusinessConnection");

/**
 * Google Business Profile "local posts" publisher for the unified social posting system.
 *
 * This is the ONLY write UC performs against Google. Profile information (title, hours,
 * address, media) stays read-only in googleBusinessService; this module only calls
 * `accounts.locations.localPosts.create` (Business Profile API v4, `business.manage` scope —
 * the same scope the existing connection already requests, so no new consent is needed).
 */

const LOCAL_POSTS_BASE = "https://mybusiness.googleapis.com/v4";
const SUMMARY_MAX_LENGTH = 1500;
const CALL_TO_ACTION_TYPES = Object.freeze(["BOOK", "ORDER", "SHOP", "LEARN_MORE", "SIGN_UP", "CALL"]);
const ACCOUNT_NAME_PATTERN = /^accounts\/[A-Za-z0-9_-]+$/;
const LOCATION_NAME_PATTERN = /^locations\/[A-Za-z0-9_-]+$/;
const LANGUAGE_CODE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/**
 * Error with a user-facing message and a stable code the frontend can act on
 * (e.g. RECONNECT_REQUIRED shows a Reconnect button). `status` 400 marks a validation
 * failure the controller should answer as a client error.
 */
class GoogleBusinessPostError extends Error {
  constructor(message, { code = "PUBLISH_FAILED", status, reconnectRequired = false } = {}) {
    super(message);
    this.name = "GoogleBusinessPostError";
    this.code = code;
    this.reconnectRequired = reconnectRequired;
    if (status) this.status = status;
  }
}

function invalid(message) {
  return new GoogleBusinessPostError(message, { code: "INVALID_POST", status: 400 });
}

/**
 * Validates the Google-specific part of a unified post. Called up front by publish and
 * schedule so a bad post is rejected before any provider is contacted or a job is queued.
 * @returns {{ accountName: string, locationName: string, callToAction: Object|null, languageCode: string }}
 */
function validatePostInput({ text = "", imageUrl = "", videoUrl = "", accountName, locationName, callToAction, languageCode } = {}) {
  const summary = String(text || "").trim();
  const account = String(accountName || "").trim();
  const location = String(locationName || "").trim();

  if (!account || !location) {
    throw invalid("Select the Google Business Profile location to post to.");
  }
  if (!ACCOUNT_NAME_PATTERN.test(account) || !LOCATION_NAME_PATTERN.test(location)) {
    throw invalid("The selected Google Business Profile location is invalid. Reload your locations and select it again.");
  }
  if (videoUrl && !imageUrl) {
    throw invalid("Google Business Profile posts support photos only. Attach an image or remove the video.");
  }
  if (!summary && !imageUrl) {
    throw invalid("Google Business Profile posts need text or a photo.");
  }
  if (summary.length > SUMMARY_MAX_LENGTH) {
    throw invalid(`Google Business Profile posts are limited to ${SUMMARY_MAX_LENGTH} characters (currently ${summary.length}).`);
  }

  let cta = null;
  if (callToAction && callToAction.actionType) {
    const actionType = String(callToAction.actionType).toUpperCase();
    if (!CALL_TO_ACTION_TYPES.includes(actionType)) {
      throw invalid(`Unsupported Google button type '${callToAction.actionType}'.`);
    }
    if (actionType === "CALL") {
      // Google dials the location's primary phone number; a URL is not allowed.
      cta = { actionType };
    } else {
      const url = String(callToAction.url || "").trim();
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        throw invalid("Enter a valid link (https://...) for the Google post button.");
      }
      if (!["http:", "https:"].includes(parsed.protocol)) {
        throw invalid("The Google post button link must start with http:// or https://.");
      }
      cta = { actionType, url: parsed.toString() };
    }
  }

  const lang = String(languageCode || "").trim();
  return {
    accountName: account,
    locationName: location,
    callToAction: cta,
    languageCode: LANGUAGE_CODE_PATTERN.test(lang) ? lang : "en",
  };
}

function buildLocalPost({ text, imageUrl }, { callToAction, languageCode }) {
  const body = { languageCode, topicType: "STANDARD" };
  const summary = String(text || "").trim();
  if (summary) body.summary = summary;
  if (imageUrl) body.media = [{ mediaFormat: "PHOTO", sourceUrl: imageUrl }];
  if (callToAction) body.callToAction = callToAction;
  return body;
}

async function markConnection(user, status) {
  if (GoogleConnection.db.readyState !== 1) return;
  try {
    await GoogleConnection.updateOne(
      { tenantId: user.tenantId || user._id, userId: user._id },
      { $set: { status } }
    );
  } catch (error) {
    logger.warn("google_business.post.mark_connection_failed", { userId: user?._id, error: error.message });
  }
}

/** Translates a Google API/token error into a GoogleBusinessPostError with a readable message. */
function toFriendlyError(error) {
  if (error instanceof GoogleBusinessPostError) return error;

  // getValidAccessToken already produces readable messages; they end in "reconnect is required"
  // when the stored authorization is missing or revoked.
  if (!error.response) {
    if (/reconnect is required/i.test(error.message || "")) {
      return new GoogleBusinessPostError(
        "Your Google Business Profile is not connected or its authorization expired. Reconnect it to keep posting.",
        { code: "RECONNECT_REQUIRED", reconnectRequired: true }
      );
    }
    if (/refresh failed/i.test(error.message || "")) {
      return new GoogleBusinessPostError("Google could not refresh your sign-in right now. Please try again in a moment.", { code: "PROVIDER_UNAVAILABLE" });
    }
    if (error.code === "ECONNABORTED" || /timeout/i.test(error.message || "")) {
      return new GoogleBusinessPostError("Google took too long to respond. Check your Business Profile before retrying so the post isn't duplicated.", { code: "PROVIDER_TIMEOUT" });
    }
    return new GoogleBusinessPostError("Could not reach Google Business Profile. Please try again.", { code: "PUBLISH_FAILED" });
  }

  const status = error.response.status;
  const providerError = error.response.data?.error || {};
  const providerStatus = String(providerError.status || "");
  const reasons = JSON.stringify(providerError.details || []);
  const providerMessage = String(providerError.message || "");

  if (status === 401 || /ACCESS_TOKEN_SCOPE_INSUFFICIENT/.test(reasons)) {
    return new GoogleBusinessPostError(
      "Google rejected your saved authorization. Reconnect your Google Business Profile and grant the requested permissions.",
      { code: "RECONNECT_REQUIRED", reconnectRequired: true }
    );
  }
  if (status === 403) {
    if (/SERVICE_DISABLED|accessNotConfigured|has not been used/i.test(reasons + providerMessage)) {
      return new GoogleBusinessPostError(
        "The Google Business Profile API is not enabled or approved for this app's Google Cloud project. Ask your administrator to request access.",
        { code: "API_NOT_ENABLED" }
      );
    }
    return new GoogleBusinessPostError(
      "Your Google account doesn't have permission to post for this location. Make sure you are an owner or manager of the profile and that it is verified.",
      { code: "PERMISSION_DENIED" }
    );
  }
  if (status === 404) {
    return new GoogleBusinessPostError(
      "This Google Business Profile location was not found. It may have been removed or moved to another account — reload your locations.",
      { code: "LOCATION_NOT_FOUND" }
    );
  }
  if (status === 429) {
    return new GoogleBusinessPostError("Google is limiting requests right now. Wait a minute and try again.", { code: "RATE_LIMITED" });
  }
  if (status === 400 || providerStatus === "INVALID_ARGUMENT" || providerStatus === "FAILED_PRECONDITION") {
    if (/media|photo|image|sourceUrl/i.test(reasons + providerMessage)) {
      return new GoogleBusinessPostError(
        "Google couldn't use the attached photo. Use a public JPG or PNG between 10 KB and 5 MB, at least 250×250 pixels.",
        { code: "INVALID_MEDIA" }
      );
    }
    if (/call_?to_?action|url/i.test(reasons + providerMessage)) {
      return new GoogleBusinessPostError("Google rejected the post button. Check the button type and link.", { code: "INVALID_POST" });
    }
    if (/verif/i.test(reasons + providerMessage)) {
      return new GoogleBusinessPostError("Google only allows posts on verified Business Profiles. Verify this location in Google first.", { code: "LOCATION_NOT_VERIFIED" });
    }
    return new GoogleBusinessPostError(
      "Google rejected the post. Check that the text follows Google's content policies and try again.",
      { code: "INVALID_POST" }
    );
  }
  if (status >= 500) {
    return new GoogleBusinessPostError("Google Business Profile is temporarily unavailable. Please try again shortly.", { code: "PROVIDER_UNAVAILABLE" });
  }
  return new GoogleBusinessPostError("Google Business Profile could not publish this post.", { code: "PUBLISH_FAILED" });
}

async function createWithRateLimitRetry(operation, attempts = 3) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      // Only 429 is retried: the create was refused outright. Retrying a 5xx/timeout on a
      // non-idempotent create could publish the same post twice.
      if (error.response?.status !== 429 || attempt >= attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
    }
  }
}

/**
 * Publishes one local post to the selected location using the caller's own Google connection.
 * Google itself enforces that the caller can manage `accountName/locationName`.
 * @returns {Promise<{ postId: string, postUrl: string|null, state: string|null }>}
 */
async function publishLocalPost(user, postData = {}) {
  if (!user?._id) throw new GoogleBusinessPostError("User authentication required", { status: 401 });
  const input = validatePostInput(postData);
  const parent = `${input.accountName}/${input.locationName}`;

  try {
    const token = await googleBusinessService.getValidAccessToken(user);
    const response = await createWithRateLimitRetry(() => axios.post(
      `${LOCAL_POSTS_BASE}/${parent}/localPosts`,
      buildLocalPost(postData, input),
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, timeout: 20_000 }
    ));
    const localPost = response.data || {};
    logger.info("google_business.post.published", {
      userId: user._id,
      tenantId: user.tenantId,
      location: parent,
      state: localPost.state,
    });
    return {
      postId: localPost.name || `${parent}/localPosts/unknown`,
      postUrl: localPost.searchUrl || null,
      state: localPost.state || null,
    };
  } catch (error) {
    const friendly = toFriendlyError(error);
    logger.error("google_business.post.failed", {
      userId: user._id,
      tenantId: user.tenantId,
      location: parent,
      status: error.response?.status,
      providerStatus: error.response?.data?.error?.status,
      code: friendly.code,
      error: error.response?.data?.error?.message || error.message,
    });
    if (error.response?.status === 401 || /ACCESS_TOKEN_SCOPE_INSUFFICIENT/.test(JSON.stringify(error.response?.data?.error?.details || []))) {
      await markConnection(user, "revoked");
    }
    throw friendly;
  }
}

module.exports = {
  SUMMARY_MAX_LENGTH,
  CALL_TO_ACTION_TYPES,
  GoogleBusinessPostError,
  validatePostInput,
  buildLocalPost,
  toFriendlyError,
  publishLocalPost,
};
