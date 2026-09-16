"use strict";

const mongoose = require("mongoose");
const Business = require("../models/Business");
const Category = require("../models/Category");
const logger = require("../utils/logger");
const googleBusinessService = require("../services/googleBusinessService");
const googleBusinessImportService = require("../services/googleBusinessImportService");
const { escapeRegex } = require("../services/businessImportService");
const GoogleConnection = require("../models/GoogleBusinessConnection");
const { oauthResultUrl } = require("../utils/oauthRedirect");

/** Maps a Google/import-service error to the HTTP status + message the frontend already handles. */
function respondToGoogleError(res, error, fallbackMessage) {
  logger.error("google_business.request_failed", { error: error.message });
  if (error.status) {
    const body = { success: false, message: error.message };
    if (error.existingBusinessId) body.existingBusinessId = error.existingBusinessId;
    if (error.claimable) body.claimable = error.claimable;
    if (error.requiresCategory) body.requiresCategory = error.requiresCategory;
    if (error.suggestedCategoryName) body.suggestedCategoryName = error.suggestedCategoryName;
    return res.status(error.status).json(body);
  }
  const httpStatus = error.response?.status;
  if (httpStatus === 429) {
    return res.status(429).json({ success: false, message: "Google API rate limit exceeded. Please wait a moment and try again." });
  }
  if (httpStatus === 403) {
    return res.status(403).json({ success: false, message: "Google Business Profile API access not granted. This API requires explicit approval from Google — see the Google Cloud Console." });
  }
  return res.status(500).json({ success: false, message: `${fallbackMessage}: ${error.message}` });
}

/**
 * GET /api/google-business/status
 * Lightweight DB-only check — no Google API calls, no quota consumed.
 * Returns whether the user has an active Google Business connection.
 */
exports.getConnectionStatus = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, isConnected: false });
    const conn = await GoogleConnection.findOne({
      tenantId: req.user.tenantId || req.user._id,
      userId: req.user._id,
    }).select("status connectedAt googleEmail googleName googlePicture selectedProfileId lastFetchedProfile");
    if (!conn) return res.json({ success: true, isConnected: false });
    return res.json({
      success: true,
      isConnected: conn.status === "connected",
      status: conn.status,
      connectedAt: conn.connectedAt,
      googleEmail: conn.googleEmail || null,
      googleName: conn.googleName || null,
      googlePicture: conn.googlePicture || null,
      selectedProfileId: conn.selectedProfileId || null,
      profileName: conn.lastFetchedProfile?.businessName || null,
      lastFetchedProfile: conn.lastFetchedProfile || null,
    });
  } catch (error) {
    logger.error("google.status.failed", { userId: req.user?._id, error: error.message });
    return res.status(500).json({ success: false, isConnected: false, message: error.message });
  }
};

/**
 * GET /api/google-business/auth-url
 * Returns the Google OAuth connection URL.
 */
exports.getAuthUrl = async (req, res) => {
  try {
    const url = await googleBusinessService.createAuthorizationRequest(req.user, req.query.returnTo);
    return res.status(200).json({ success: true, url });
  } catch (error) {
    logger.error("Error generating Google Business Profile auth URL", { error: error.message });
    return res.status(500).json({ success: false, message: "Failed to generate Google auth URL" });
  }
};

/**
 * GET /api/google-business/callback
 * Handles the Google OAuth redirect after the user grants (or denies) consent.
 * This endpoint does NOT require authMiddleware because Google cannot carry a JWT;
 * the user identity is recovered from the `state` query param (set to the user's _id
 * when the auth URL was generated).
 *
 * On success  → redirects to FRONTEND_URL/businessEdit?gmb=connected
 * On failure  → redirects to FRONTEND_URL/businessEdit?gmb=error&reason=<message>
 */
exports.handleCallback = async (req, res) => {
  const { code, state, error: oauthError } = req.query;

  // Google returns `error=access_denied` when the user cancels or denies permission
  if (oauthError) {
    logger.warn("Google OAuth callback: user denied access or error returned", { error: oauthError });
    const cancelled = await googleBusinessService.cancelAuthorizationRequest(state);
    return res.redirect(oauthResultUrl(cancelled?.returnTo || "/settings/integrations", { gmb: "error", reason: oauthError }));
  }

  if (!code) {
    logger.error("Google OAuth callback: no authorization code received");
    return res.redirect(oauthResultUrl("/settings/integrations", { gmb: "error", reason: "missing_code" }));
  }

  if (!state) {
    logger.error("Google OAuth callback: state missing from callback");
    return res.redirect(oauthResultUrl("/settings/integrations", { gmb: "error", reason: "missing_state" }));
  }

  try {
    const result = await googleBusinessService.connectFromCallback(code, state);
    logger.info("Google OAuth callback: account connected successfully", { userId: result.userId });
    // NOTE: We intentionally do NOT prefetch profiles here to avoid burning Google API quota
    // (mybusinessaccountmanagement.googleapis.com has strict rate limits).
    // Profiles are fetched lazily when the user opens the Business Edit or Integrations page.
    return res.redirect(oauthResultUrl(result.returnTo, { gmb: "connected" }));
  } catch (error) {
    logger.error("Google OAuth callback: token exchange failed", { error: error.message });
    return res.redirect(oauthResultUrl("/settings/integrations", { gmb: "error", reason: "oauth_failed" }));
  }
};

/**
 * POST /api/google-business/connect
 * Exchanges authorization code for tokens, encrypts them, and saves to user profile.
 */
exports.connectAccount = async (req, res) => {
  return res.status(410).json({ success: false, message: "Direct code exchange is disabled; start OAuth with GET /api/google-business/auth-url" });
};

/**
 * POST /api/google-business/disconnect
 * Disconnects the user's Google account by clearing stored tokens.
 */
exports.disconnectAccount = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }

    await GoogleConnection.deleteOne({ tenantId: req.user.tenantId || req.user._id, userId: req.user._id });
    logger.info("User disconnected Google Business Profile account", { userId: req.user._id });

    return res.status(200).json({
      success: true,
      message: "Google account disconnected successfully",
    });
  } catch (error) {
    logger.error("Error disconnecting Google account", { error: error.message });
    return res.status(500).json({ success: false, message: "Failed to disconnect Google account" });
  }
};

/**
 * GET /api/google-business/profiles
 * Fetches all Business Profile locations the connected Google account can access.
 * Read-only: unlike the previous implementation, this never creates or modifies any
 * Business document — importing is a separate, explicit user action (see importLocation
 * below). Each profile is annotated with its link status so the frontend can show
 * "Already imported", "Linked to another account", or offer a fresh import.
 */
exports.getProfiles = async (req, res) => {
  try {
    const connection = req.user && (await googleBusinessService.connection(req.user));
    if (!connection || connection.status !== "connected") {
      return res.status(401).json({ success: false, message: "Google account not connected" });
    }

    const profiles = await googleBusinessService.fetchAllProfilesForUser(req.user);

    const locationIds = profiles.map((p) => p.businessId).filter(Boolean);
    const linkedBusinesses = locationIds.length
      ? await Business.find({ googleLocationId: { $in: locationIds } }).select("_id userId googleLocationId").lean()
      : [];
    const linkedByLocationId = new Map(linkedBusinesses.map((b) => [b.googleLocationId, b]));

    const categoryNames = [...new Set(profiles.map((p) => p.category).filter(Boolean))];
    const categories = categoryNames.length
      ? await Category.find({ name: { $in: categoryNames.map((n) => new RegExp(`^${escapeRegex(n)}$`, "i")) } }).select("_id name").lean()
      : [];
    const categoryByLowerName = new Map(categories.map((c) => [c.name.toLowerCase(), c._id]));

    const annotatedProfiles = profiles.map((p) => {
      const linked = p.businessId ? linkedByLocationId.get(p.businessId) : null;
      return {
        ...p,
        linkedBusinessId: linked ? linked._id : null,
        linkedToCurrentUser: linked ? String(linked.userId || "") === String(req.user._id) : false,
        suggestedCategoryId: p.category ? categoryByLowerName.get(p.category.toLowerCase()) || null : null,
      };
    });

    return res.status(200).json({
      success: true,
      count: annotatedProfiles.length,
      profiles: annotatedProfiles,
    });
  } catch (error) {
    logger.error("Error fetching Google Business Profiles", { error: error.message });
    const httpStatus = error.response?.status;
    if (httpStatus === 429) {
      return res.status(429).json({ success: false, message: "Google API rate limit exceeded. Please wait a moment and try again." });
    }
    if (httpStatus === 403) {
      return res.status(403).json({ success: false, message: "Google Business Profile API access not granted. This API requires explicit approval from Google — see the Google Cloud Console." });
    }
    return res.status(500).json({
      success: false,
      message: "Failed to fetch Business Profiles: " + error.message,
    });
  }
};

/**
 * POST /api/google-business/import-location
 * Imports one Google Business Profile location, chosen by the user, into UC as a normal
 * Business (or syncs it if already linked to one of the user's own businesses). This is
 * the single creation path for the "Import from Google Business Profile" flow; it reuses
 * businessService.createBusiness — the same function the manual creation form uses.
 */
exports.importLocation = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }
    const { accountName, locationName, categoryId, subCategoryIds } = req.body || {};
    if (!locationName) {
      return res.status(400).json({ success: false, message: "locationName is required." });
    }

    const { business, created } = await googleBusinessImportService.importLocation(req.user, {
      accountName,
      locationName,
      categoryId,
      subCategoryIds,
    });

    return res.status(created ? 201 : 200).json({
      success: true,
      created,
      message: created ? "Business imported from Google Business Profile." : "Existing business synced from Google Business Profile.",
      business,
      businessId: business._id,
    });
  } catch (error) {
    return respondToGoogleError(res, error, "Failed to import Business Profile");
  }
};

/**
 * POST /api/google-business/select-profile
 * Saves the selected Google Business Profile location ID and caches its normalized 9 fields.
 */
exports.selectProfile = async (req, res) => {
  try {
    const { locationName, businessId } = req.body;
    const targetLocationId = locationName || businessId;

    if (!targetLocationId) {
      return res.status(400).json({ success: false, message: "locationName or businessId is required" });
    }

    const activeConnection = req.user && (await googleBusinessService.connection(req.user));
    if (!activeConnection || activeConnection.status !== "connected") {
      return res.status(401).json({ success: false, message: "Google account not connected" });
    }

    const profile = await googleBusinessService.fetchProfileByLocationName(req.user, targetLocationId);

    const googleConnection = activeConnection;
    googleConnection.selectedProfileId = targetLocationId;
    googleConnection.lastFetchedProfile = profile;
    await googleConnection.save();

    logger.info("Selected Google Business Profile location for user", {
      userId: req.user._id,
      locationId: targetLocationId,
    });

    return res.status(200).json({
      success: true,
      message: "Profile selected successfully",
      profile,
    });
  } catch (error) {
    return respondToGoogleError(res, error, "Failed to select profile");
  }
};

/**
 * GET /api/google-business/selected-profile
 * Returns the normalized 9 details of the currently selected Google Business Profile.
 */
exports.getSelectedProfile = async (req, res) => {
  try {
    const googleConnection = req.user && (await googleBusinessService.connection(req.user));
    if (!googleConnection || googleConnection.status !== "connected") {
      return res.status(401).json({ success: false, message: "Google account not connected" });
    }

    const selectedId = googleConnection.selectedProfileId;
    if (!selectedId) {
      return res.status(404).json({ success: false, message: "No Google Business Profile selected yet" });
    }

    let profile = googleConnection.lastFetchedProfile;
    if (!profile || !profile.businessId) {
      profile = await googleBusinessService.fetchProfileByLocationName(req.user, selectedId);
      googleConnection.lastFetchedProfile = profile;
      await googleConnection.save();
    }

    return res.status(200).json({
      success: true,
      profile,
    });
  } catch (error) {
    logger.error("Error fetching selected profile details", { error: error.message });
    return res.status(500).json({
      success: false,
      message: "Failed to fetch selected profile details: " + error.message,
    });
  }
};

/**
 * POST /api/google-business/populate-profile
 * Populates local Mongoose User and/or Business documents with the fetched GMB data.
 * STRICTLY READ-ONLY against Google (never updates Google Business Profile).
 */
exports.populateProfile = async (req, res) => {
  try {
    const googleConnection = req.user && (await googleBusinessService.connection(req.user));
    if (!googleConnection || googleConnection.status !== "connected") {
      return res.status(401).json({ success: false, message: "Google account not connected" });
    }

    const selectedId = googleConnection.selectedProfileId;
    if (!selectedId) {
      return res.status(400).json({
        success: false,
        message: "Please select a Google Business Profile location first before populating local profiles.",
      });
    }

    let profile = googleConnection.lastFetchedProfile;
    if (!profile || !profile.businessId) {
      profile = await googleBusinessService.fetchProfileByLocationName(req.user, selectedId);
      googleConnection.lastFetchedProfile = profile;
      await googleConnection.save();
    }

    const target = (req.body.target || "both").toLowerCase();
    const { businessId } = req.body;

    let userUpdated = false;
    let businessUpdated = false;
    let targetBusiness = null;

    // 1. Populate User Profile
    if (target === "user" || target === "both") {
      if (!req.user.phone && profile.phoneNumber) {
        req.user.phone = profile.phoneNumber;
      }
      if (profile.address?.city) req.user.city = profile.address.city;
      if (profile.address?.state) req.user.area = profile.address.state;
      if (profile.address?.pincode) req.user.pincode = profile.address.pincode;
      if (profile.address?.country) req.user.country = profile.address.country;

      await req.user.save();
      userUpdated = true;
    }

    // 2. Populate Business Profile
    // Enrichment only — delegates to the same ownership-scoped lookup and fill-only sync the
    // creation flow uses (googleBusinessImportService), instead of a second, independent
    // Business-mutation path. Creating a brand-new business from Google now happens exclusively
    // through POST /api/google-business/import-location, which enforces a UC category the way
    // every other creation path does; this endpoint no longer creates businesses with no category.
    if (target === "business" || target === "both") {
      if (businessId) {
        targetBusiness = await Business.findOne({ _id: businessId, userId: req.user._id });
        if (!targetBusiness) {
          return res.status(404).json({ success: false, message: "Specified target Business not found" });
        }
      } else {
        targetBusiness = await googleBusinessImportService.findLinkedBusiness(req.user._id, profile);
        if (targetBusiness && String(targetBusiness.userId || "") !== String(req.user._id)) {
          return res.status(403).json({ success: false, message: "You do not own this business." });
        }
      }

      if (!targetBusiness) {
        return res.status(400).json({
          success: false,
          message: 'No existing business to populate from this Google Business Profile. Use "Import from Google Business Profile" on the business creation page to create one.',
        });
      }

      targetBusiness = await googleBusinessImportService.syncLinkedBusiness(targetBusiness, profile, {}, {
        accountName: targetBusiness.googleAccountName,
      });
      businessUpdated = true;
    }

    logger.info("Successfully populated local profiles from Google Business Profile", {
      userId: req.user._id,
      target,
      userUpdated,
      businessUpdated,
      businessId: targetBusiness?._id,
    });

    return res.status(200).json({
      success: true,
      message: "Successfully populated local profile from Google Business Profile (strictly read-only)",
      target,
      userUpdated,
      businessUpdated,
      business: targetBusiness,
    });
  } catch (error) {
    logger.error("Error populating local profile from GMB", { error: error.message });
    return res.status(500).json({
      success: false,
      message: "Failed to populate profile: " + error.message,
    });
  }
};
