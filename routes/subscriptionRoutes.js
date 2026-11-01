// backend/routes/subscriptionRoutes.js
const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middlewares/authMiddleware");
const { requireAdmin } = require("../middlewares/requireAdmin");
const {
  createPayPalSubscription,
  handlePayPalWebhook,
  createRazorpaySubscription,
  verifyRazorpayWebhook,
  verifyRazorpaySubscription,
  getBusinessSubscription,
  cancelBusinessSubscription,
  reactivateBusinessSubscription,
  getAllBusinessSubscriptions, // Admin
  adminSetBusinessPlan, // Admin
} = require("../controllers/subscriptionController");

// PAYPAL ROUTES
router.post(
  "/create-paypal-subscription",
  authMiddleware,
  createPayPalSubscription
);
router.post(
  "/paypal-webhook",
  express.raw({ type: "application/json" }),
  handlePayPalWebhook
);

// RAZORPAY ROUTES
router.post(
  "/create-razorpay-subscription",
  authMiddleware,
  createRazorpaySubscription
);
router.post(
  "/razorpay-webhook",
  express.raw({ type: "application/json" }),
  verifyRazorpayWebhook
);
router.post(
  "/verify-razorpay-subscription",
  authMiddleware,
  verifyRazorpaySubscription
);

// BUSINESS-SPECIFIC ROUTES
router.get("/business/:businessId", authMiddleware, getBusinessSubscription);
router.post("/cancel/:businessId", authMiddleware, cancelBusinessSubscription);
router.post(
  "/reactivate/:businessId",
  authMiddleware,
  reactivateBusinessSubscription
);

// ADMIN ROUTES
router.get("/admin/all", authMiddleware, requireAdmin("packages"), getAllBusinessSubscriptions);
router.patch("/admin/business/:businessId", authMiddleware, requireAdmin("packages"), adminSetBusinessPlan);

module.exports = router;
