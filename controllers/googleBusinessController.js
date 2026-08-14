"use strict";

const mongoose = require("mongoose");
const Business = require("../models/Business");
const logger = require("../utils/logger");
const googleBusinessService = require("../services/googleBusinessService");
const GoogleConnection = require("../models/GoogleBusinessConnection");
const { oauthResultUrl } = require("../utils/oauthRedirect");

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
    return res.redirect(oauthResultUrl("/settings/integrations", { gmb: "error", reason: oauthError }));
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
 * Helper: Automatically create / update a Business listing in UrbanCitations from a Google Business Profile location
 */
async function autoImportProfileToBusiness(user, profile) {
  if (!profile || !profile.businessName) return null;
  const name = profile.businessName.trim();
  const locId = profile.businessId || "";

  // Check if business already exists
  let targetBusiness = await Business.findOne({
    userId: user._id,
    $or: [
      ...(locId ? [{ googleLocationId: locId }] : []),
      { businessName: new RegExp(`^${name}$`, "i") }
    ]
  });

  const rawCoords = [
    Number(profile.locationDetails?.longitude) || 0,
    Number(profile.locationDetails?.latitude) || 0,
  ];

  if (!targetBusiness) {
    targetBusiness = new Business({
      userId: user._id,
      businessName: name,
      googleLocationId: locId,
      address: {
        pincode: profile.address?.pincode || "000000",
        city: profile.address?.city || "Unknown",
        state: profile.address?.state || "Unknown",
        country: profile.address?.country || "US",
        streetName: profile.address?.streetName || "",
      },
      addressString: profile.address?.formattedAddress || "",
      location: {
        type: "Point",
        coordinates: rawCoords,
      },
      description: profile.description || "",
      website: profile.website || "",
      importedCategory: profile.category || "",
      contact: {
        contactDetails: [
          {
            title: "Mr",
            name: user.full_name || "Owner",
            mobileNumbers: profile.phoneNumber ? [profile.phoneNumber] : ["0000000000"],
          }
        ]
      }
    });

    await targetBusiness.save();

    user.businesses = user.businesses || [];
    if (!user.businesses.some((id) => id.toString() === targetBusiness._id.toString())) {
      user.businesses.push(targetBusiness._id);
      await user.save();
    }
  } else {
    // Update existing business details if needed
    if (locId && !targetBusiness.googleLocationId) {
      targetBusiness.googleLocationId = locId;
    }
    if (profile.address?.formattedAddress && !targetBusiness.addressString) {
      targetBusiness.addressString = profile.address.formattedAddress;
    }
    if (profile.category && !targetBusiness.importedCategory) {
      targetBusiness.importedCategory = profile.category;
    }
    await targetBusiness.save();
  }

  return targetBusiness;
}

exports.autoImportProfileToBusiness = autoImportProfileToBusiness;

/**
 * GET /api/google-business/profiles
 * Fetches all available Business Profiles across connected accounts and auto-syncs them to Business listings.
 */
exports.getProfiles = async (req, res) => {
  try {
    if (!req.user || !(await googleBusinessService.connection(req.user))) {
      return res.status(401).json({ success: false, message: "Google account not connected" });
    }

    const profiles = await googleBusinessService.fetchAllProfilesForUser(req.user);

    // Auto-create / sync business listings in UrbanCitations for each profile
    const importedBusinesses = [];
    for (const p of profiles) {
      try {
        const biz = await autoImportProfileToBusiness(req.user, p);
        if (biz) importedBusinesses.push(biz);
      } catch (err) {
        logger.warn("google.auto_import.error", { profileId: p.businessId, error: err.message });
      }
    }

    return res.status(200).json({
      success: true,
      count: profiles.length,
      profiles,
      importedBusinesses,
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

    if (!req.user || !(await googleBusinessService.connection(req.user))) {
      return res.status(401).json({ success: false, message: "Google account not connected" });
    }

    const profile = await googleBusinessService.fetchProfileByLocationName(req.user, targetLocationId);

    const googleConnection = await googleBusinessService.connection(req.user);
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
    logger.error("Error selecting Google Business Profile", { error: error.message });
    return res.status(500).json({
      success: false,
      message: "Failed to select profile: " + error.message,
    });
  }
};

/**
 * GET /api/google-business/selected-profile
 * Returns the normalized 9 details of the currently selected Google Business Profile.
 */
exports.getSelectedProfile = async (req, res) => {
  try {
    const googleConnection = req.user && (await googleBusinessService.connection(req.user));
    if (!googleConnection) {
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
    if (!googleConnection) {
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
    if (target === "business" || target === "both") {
      if (businessId) {
        targetBusiness = await Business.findOne({ _id: businessId, userId: req.user._id });
        if (!targetBusiness) {
          return res.status(404).json({ success: false, message: "Specified target Business not found" });
        }
      } else if (req.user.businesses && req.user.businesses.length > 0) {
        targetBusiness = await Business.findById(req.user.businesses[0]);
      }

      if (!targetBusiness) {
        targetBusiness = new Business({
          userId: req.user._id,
          businessName: profile.businessName || "New Business",
          address: {
            pincode: profile.address?.pincode || "000000",
            city: profile.address?.city || "Unknown",
            state: profile.address?.state || "Unknown",
            country: profile.address?.country || "US",
          },
          location: {
            type: "Point",
            coordinates: [
              profile.locationDetails?.longitude || 0,
              profile.locationDetails?.latitude || 0,
            ],
          },
        });
      }

      // Populate core details safely
      if (profile.businessName) targetBusiness.businessName = profile.businessName;
      if (profile.description) targetBusiness.description = profile.description;
      if (profile.website) targetBusiness.website = profile.website;

      if (profile.address) {
        targetBusiness.address = targetBusiness.address || {};
        if (profile.address.streetName) targetBusiness.address.streetName = profile.address.streetName;
        if (profile.address.city) targetBusiness.address.city = profile.address.city;
        if (profile.address.state) targetBusiness.address.state = profile.address.state;
        if (profile.address.pincode) targetBusiness.address.pincode = profile.address.pincode;
        if (profile.address.country) targetBusiness.address.country = profile.address.country;
      }

      if (profile.locationDetails && (profile.locationDetails.latitude !== 0 || profile.locationDetails.longitude !== 0)) {
        targetBusiness.location = {
          type: "Point",
          coordinates: [profile.locationDetails.longitude, profile.locationDetails.latitude],
        };
      }

      if (profile.phoneNumber) {
        targetBusiness.contact = targetBusiness.contact || {};
        targetBusiness.contact.contactDetails = targetBusiness.contact.contactDetails || [];
        if (targetBusiness.contact.contactDetails.length === 0) {
          targetBusiness.contact.contactDetails.push({
            title: "Mr",
            name: req.user.full_name || "Owner",
            mobileNumbers: [profile.phoneNumber],
          });
        } else if (!targetBusiness.contact.contactDetails[0].mobileNumbers.includes(profile.phoneNumber)) {
          targetBusiness.contact.contactDetails[0].mobileNumbers.push(profile.phoneNumber);
        }
      }

      if (profile.category) {
        targetBusiness.importedCategory = profile.category;
      }

      const isNewBusiness = !targetBusiness._id || targetBusiness.isNew;
      await targetBusiness.save();

      if (isNewBusiness) {
        req.user.businesses = req.user.businesses || [];
        req.user.businesses.push(targetBusiness._id);
        await req.user.save();
      }

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
