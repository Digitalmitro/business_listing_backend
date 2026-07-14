"use strict";

const mongoose = require("mongoose");
const User = require("../models/User");
const Business = require("../models/Business");
const logger = require("../utils/logger");
const googleBusinessService = require("../services/googleBusinessService");

/**
 * GET /api/google-business/auth-url
 * Returns the Google OAuth connection URL.
 */
exports.getAuthUrl = async (req, res) => {
  try {
    const state = req.user && req.user._id ? String(req.user._id) : "";
    const url = googleBusinessService.getAuthUrl(state);
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
  const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "");
  const successRedirect = `${frontendUrl}/businessEdit?gmb=connected`;

  const { code, state: userId, error: oauthError } = req.query;

  // Google returns `error=access_denied` when the user cancels or denies permission
  if (oauthError) {
    logger.warn("Google OAuth callback: user denied access or error returned", { error: oauthError });
    return res.redirect(`${frontendUrl}/businessEdit?gmb=error&reason=${encodeURIComponent(oauthError)}`);
  }

  if (!code) {
    logger.error("Google OAuth callback: no authorization code received");
    return res.redirect(`${frontendUrl}/businessEdit?gmb=error&reason=missing_code`);
  }

  if (!userId) {
    logger.error("Google OAuth callback: state (userId) missing from callback");
    return res.redirect(`${frontendUrl}/businessEdit?gmb=error&reason=missing_state`);
  }

  try {
    const user = await User.findById(userId);
    if (!user) {
      logger.error("Google OAuth callback: user not found for state", { userId });
      return res.redirect(`${frontendUrl}/businessEdit?gmb=error&reason=user_not_found`);
    }

    const tokenData = await googleBusinessService.exchangeCodeForTokens(code);

    user.googleBusinessProfile = {
      isConnected: true,
      googleAccountId: tokenData.googleAccountId,
      googleEmail: tokenData.googleEmail,
      accessToken: tokenData.accessToken,
      refreshToken: tokenData.refreshToken,
      tokenExpiry: tokenData.tokenExpiry,
      connectedAt: new Date(),
    };

    await user.save();
    logger.info("Google OAuth callback: account connected successfully", { userId: user._id, googleEmail: tokenData.googleEmail });

    // Best-effort prefetch profiles so the UI loads instantly
    try {
      await googleBusinessService.fetchAllProfilesForUser(user);
    } catch (fetchErr) {
      logger.warn("Google OAuth callback: could not prefetch profiles", { error: fetchErr.message });
    }

    return res.redirect(successRedirect);
  } catch (error) {
    logger.error("Google OAuth callback: token exchange failed", { error: error.message, userId });
    return res.redirect(`${frontendUrl}/businessEdit?gmb=error&reason=${encodeURIComponent(error.message)}`);
  }
};

/**
 * POST /api/google-business/connect
 * Exchanges authorization code for tokens, encrypts them, and saves to user profile.
 */
exports.connectAccount = async (req, res) => {
  try {
    const code = req.body.code || req.query.code;
    if (!code) {
      return res.status(400).json({ success: false, message: "Authorization code is required" });
    }

    if (!req.user) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }

    const tokenData = await googleBusinessService.exchangeCodeForTokens(code);

    req.user.googleBusinessProfile = {
      isConnected: true,
      googleAccountId: tokenData.googleAccountId,
      googleEmail: tokenData.googleEmail,
      accessToken: tokenData.accessToken,
      refreshToken: tokenData.refreshToken,
      tokenExpiry: tokenData.tokenExpiry,
      connectedAt: new Date(),
    };

    await req.user.save();
    logger.info("User connected Google Business Profile account successfully", { userId: req.user._id });

    // Fetch initial profiles right after connection
    let profiles = [];
    try {
      profiles = await googleBusinessService.fetchAllProfilesForUser(req.user);
    } catch (fetchErr) {
      logger.warn("Could not fetch profiles immediately after connect", { error: fetchErr.message });
    }

    return res.status(200).json({
      success: true,
      message: "Google account connected successfully",
      profiles,
    });
  } catch (error) {
    logger.error("Error connecting Google account", { error: error.message });
    return res.status(500).json({
      success: false,
      message: "Failed to connect Google account: " + error.message,
    });
  }
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

    req.user.googleBusinessProfile = {
      isConnected: false,
    };

    await req.user.save();
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
 * Fetches all available Business Profiles across connected accounts.
 */
exports.getProfiles = async (req, res) => {
  try {
    if (!req.user || !req.user.googleBusinessProfile?.isConnected) {
      return res.status(401).json({ success: false, message: "Google account not connected" });
    }

    const profiles = await googleBusinessService.fetchAllProfilesForUser(req.user);
    return res.status(200).json({
      success: true,
      count: profiles.length,
      profiles,
    });
  } catch (error) {
    logger.error("Error fetching Google Business Profiles", { error: error.message });
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

    if (!req.user || !req.user.googleBusinessProfile?.isConnected) {
      return res.status(401).json({ success: false, message: "Google account not connected" });
    }

    const profile = await googleBusinessService.fetchProfileByLocationName(req.user, targetLocationId);

    req.user.googleBusinessProfile.selectedProfileId = targetLocationId;
    req.user.googleBusinessProfile.lastFetchedProfile = profile;
    await req.user.save();

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
    if (!req.user || !req.user.googleBusinessProfile?.isConnected) {
      return res.status(401).json({ success: false, message: "Google account not connected" });
    }

    const selectedId = req.user.googleBusinessProfile.selectedProfileId;
    if (!selectedId) {
      return res.status(404).json({ success: false, message: "No Google Business Profile selected yet" });
    }

    let profile = req.user.googleBusinessProfile.lastFetchedProfile;
    if (!profile || !profile.businessId) {
      profile = await googleBusinessService.fetchProfileByLocationName(req.user, selectedId);
      req.user.googleBusinessProfile.lastFetchedProfile = profile;
      await req.user.save();
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
    if (!req.user || !req.user.googleBusinessProfile?.isConnected) {
      return res.status(401).json({ success: false, message: "Google account not connected" });
    }

    const selectedId = req.user.googleBusinessProfile.selectedProfileId;
    if (!selectedId) {
      return res.status(400).json({
        success: false,
        message: "Please select a Google Business Profile location first before populating local profiles.",
      });
    }

    let profile = req.user.googleBusinessProfile.lastFetchedProfile;
    if (!profile || !profile.businessId) {
      profile = await googleBusinessService.fetchProfileByLocationName(req.user, selectedId);
      req.user.googleBusinessProfile.lastFetchedProfile = profile;
      await req.user.save();
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
