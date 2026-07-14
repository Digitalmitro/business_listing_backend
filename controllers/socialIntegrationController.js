"use strict";

const logger = require("../utils/logger");
const socialIntegrationService = require("../services/socialIntegrationService");

/**
 * GET /api/social-integrations/auth-url?platform=:platform
 * Generates the OAuth authorization URL for the target social media platform.
 */
exports.getAuthUrl = async (req, res) => {
  try {
    const platform = req.query.platform || req.params.platform;
    if (!platform) {
      return res.status(400).json({ success: false, message: "platform parameter is required" });
    }

    const state = req.user && req.user._id ? String(req.user._id) : "";
    const redirectUri = req.query.redirectUri || "";
    const url = socialIntegrationService.getAuthUrl(platform, state, redirectUri);

    return res.status(200).json({ success: true, platform: platform.toLowerCase(), url });
  } catch (error) {
    logger.error("Error generating social media auth URL", { error: error.message });
    return res.status(error.message.includes("Unsupported social media platform") ? 400 : 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * POST /api/social-integrations/connect
 * Exchanges authorization code for tokens, retrieves profile metadata, encrypts tokens, and saves to user.
 */
exports.connectAccount = async (req, res) => {
  try {
    const { platform, code, redirectUri } = req.body;
    if (!platform || !code) {
      return res.status(400).json({ success: false, message: "platform and code parameters are required" });
    }

    if (!req.user) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }

    const accountData = await socialIntegrationService.exchangeCodeAndFetchProfile(platform, code, redirectUri);

    req.user.socialMediaAccounts = req.user.socialMediaAccounts || {};
    req.user.socialMediaAccounts[platform.toLowerCase()] = accountData;

    await req.user.save();
    logger.info("User connected social media account successfully", {
      userId: req.user._id,
      platform: platform.toLowerCase(),
    });

    return res.status(200).json({
      success: true,
      message: `${socialIntegrationService.getPlatformConfig(platform).name} account connected successfully`,
      account: {
        isConnected: true,
        status: "connected",
        platformUserId: accountData.platformUserId,
        platformUsername: accountData.platformUsername,
        profileName: accountData.profileName,
        profileImageUrl: accountData.profileImageUrl,
        connectedAt: accountData.connectedAt,
        tokenExpiry: accountData.tokenExpiry,
        scopes: accountData.scopes,
      },
    });
  } catch (error) {
    logger.error("Error connecting social media account", { error: error.message });
    return res.status(error.message.includes("Unsupported social media platform") ? 400 : 500).json({
      success: false,
      message: "Failed to connect social media account: " + error.message,
    });
  }
};

/**
 * POST /api/social-integrations/disconnect
 * Disconnects the specified social media account by clearing credentials locally.
 */
exports.disconnectAccount = async (req, res) => {
  try {
    const platform = req.body.platform || req.params.platform;
    if (!platform) {
      return res.status(400).json({ success: false, message: "platform parameter is required" });
    }

    if (!req.user) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }

    await socialIntegrationService.disconnectAccount(req.user, platform);

    return res.status(200).json({
      success: true,
      message: `${platform} account disconnected successfully`,
    });
  } catch (error) {
    logger.error("Error disconnecting social media account", { error: error.message });
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/social-integrations/accounts
 * Lists connection status and profile details for all supported social media platforms.
 * Tokens are strictly redacted.
 */
exports.getAccounts = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }

    const accounts = {};
    for (const [platformKey, config] of Object.entries(socialIntegrationService.SUPPORTED_PLATFORMS)) {
      const stored = req.user.socialMediaAccounts?.[platformKey];
      if (stored && stored.isConnected) {
        accounts[platformKey] = {
          name: config.name,
          isConnected: true,
          status: stored.status || "connected",
          platformUserId: stored.platformUserId || "",
          platformUsername: stored.platformUsername || "",
          profileName: stored.profileName || "",
          profileImageUrl: stored.profileImageUrl || "",
          connectedAt: stored.connectedAt || null,
          tokenExpiry: stored.tokenExpiry || null,
          scopes: stored.scopes || config.defaultScopes,
        };
      } else {
        accounts[platformKey] = {
          name: config.name,
          isConnected: false,
          status: "not_connected",
          platformUserId: "",
          platformUsername: "",
          profileName: "",
          profileImageUrl: "",
          connectedAt: null,
          tokenExpiry: null,
          scopes: config.defaultScopes,
        };
      }
    }

    return res.status(200).json({ success: true, accounts });
  } catch (error) {
    logger.error("Error fetching connected social media accounts", { error: error.message });
    return res.status(500).json({ success: false, message: "Failed to fetch accounts: " + error.message });
  }
};

/**
 * POST /api/social-integrations/refresh
 * Proactively refreshes or verifies the access token for the specified platform.
 */
exports.refreshAccountToken = async (req, res) => {
  try {
    const { platform } = req.body;
    if (!platform) {
      return res.status(400).json({ success: false, message: "platform parameter is required" });
    }

    if (!req.user) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }

    await socialIntegrationService.getValidAccessToken(req.user, platform);
    const updatedStatus = req.user.socialMediaAccounts?.[platform.toLowerCase()]?.status || "connected";

    return res.status(200).json({
      success: true,
      message: `Successfully verified and refreshed ${platform} access token`,
      status: updatedStatus,
    });
  } catch (error) {
    logger.error("Error refreshing social media token", { error: error.message });
    const isRevoked = error.name === "RevokedPermissionError" || error.message.includes("revoked");
    return res.status(isRevoked ? 403 : 500).json({
      success: false,
      status: isRevoked ? "revoked" : "error",
      message: error.message,
    });
  }
};

/**
 * POST /api/social-integrations/verify-post
 * Verifies account readiness and allows posting exclusively through official supported endpoints.
 */
exports.verifyOrPost = async (req, res) => {
  try {
    const { platform, postData } = req.body;
    if (!platform || !postData) {
      return res.status(400).json({ success: false, message: "platform and postData are required" });
    }

    if (!req.user) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }

    const result = await socialIntegrationService.verifyOrPostToPlatform(req.user, platform, postData);
    return res.status(200).json({ success: true, result });
  } catch (error) {
    logger.error("Error verifying or posting to social media platform", { error: error.message });
    const isRevoked = error.name === "RevokedPermissionError" || error.message.includes("revoked");
    return res.status(isRevoked ? 403 : 500).json({
      success: false,
      status: isRevoked ? "revoked" : "error",
      message: error.message,
    });
  }
};
