// backend/routes/subscriptionRoutes.js
const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middlewares/authMiddleware");
const {
  createPayPalSubscription,
  handlePayPalWebhook,
  createRazorpaySubscription,
  verifyRazorpayWebhook,
  getMySubscription,
  cancelSubscription,
  reactivateSubscription,
  getAllSubscriptions,
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

// USER ROUTES
router.get("/my-subscription", authMiddleware, getMySubscription);
router.post("/cancel", authMiddleware, cancelSubscription);
router.post("/reactivate", authMiddleware, reactivateSubscription);

// ADMIN ROUTES
router.get("/all", authMiddleware, getAllSubscriptions);

module.exports = router;
