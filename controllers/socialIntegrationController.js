"use strict";

const logger = require("../utils/logger");
const service = require("../services/socialIntegrationService");
const { oauthResultUrl } = require("../utils/oauthRedirect");

exports.getAuthUrl = async (req, res) => {
  try { const platform = String(req.query.platform || "").toLowerCase(); const url = await service.createAuthorizationRequest(req.user, platform, req.query.returnTo); return res.json({ success: true, platform, url }); }
  catch (error) { logger.error("social.oauth.start.failed", { userId: req.user?._id, error: error.message }); return res.status(400).json({ success: false, message: error.message }); }
};

exports.handleCallback = async (req, res) => {
  try {
    if (req.query.error) throw new Error(req.query.error_description || req.query.error);
    if (!req.query.code || !req.query.state) throw new Error("OAuth callback requires code and state");
    const result = await service.connectFromCallback(req.params.platform, req.query.code, req.query.state);
    return res.redirect(oauthResultUrl(result.returnTo, { social: "connected", platform: req.params.platform }));
  } catch (error) {
    logger.error("social.oauth.callback.failed", { platform: req.params.platform, error: error.message });
    return res.redirect(oauthResultUrl("/settings/integrations", {
      social: "error",
      platform: req.params.platform,
      reason: "oauth_failed",
    }));
  }
};

exports.connectAccount = (_req, res) => res.status(410).json({ success: false, message: "Direct code exchange is disabled; start OAuth with GET /auth-url and follow the provider callback" });
exports.disconnectAccount = async (req, res) => { try { await service.disconnectAccount(req.user, req.body.platform || req.params.platform); return res.json({ success: true }); } catch (error) { logger.error("social.disconnect.failed", { userId: req.user?._id, error: error.message }); return res.status(400).json({ success: false, message: error.message }); } };
exports.getAccounts = async (req, res) => { try { return res.json({ success: true, accounts: await service.listAccounts(req.user) }); } catch (error) { return res.status(500).json({ success: false, message: "Could not list social connections" }); } };
exports.refreshAccountToken = async (req, res) => { try { await service.getValidAccessToken(req.user, req.body.platform); const accounts = await service.listAccounts(req.user); return res.json({ success: true, account: accounts[String(req.body.platform).toLowerCase()] }); } catch (error) { return res.status(error.name === "RevokedPermissionError" ? 403 : 400).json({ success: false, status: error.status || "error", message: error.message }); } };
exports.verifyOrPost = async (req, res) => { try { return res.json({ success: true, result: await service.verifyOrPostToPlatform(req.user, req.body.platform, req.body.postData) }); } catch (error) { return res.status(error.name === "RevokedPermissionError" ? 403 : 400).json({ success: false, message: error.message }); } };
