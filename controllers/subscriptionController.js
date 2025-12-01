// backend/controllers/subscriptionController.js
const User = require("../models/User");
const PricingPackage = require("../models/PricingPackage");
const paypal = require("@paypal/checkout-server-sdk");
const crypto = require("crypto");
const fetch = require("node-fetch"); // npm install node-fetch@2.6.7

// PayPal Environment Setup
const environment =
  process.env.NODE_ENV === "production"
    ? new paypal.core.LiveEnvironment(
        process.env.PAYPAL_CLIENT_ID,
        process.env.PAYPAL_SECRET
      )
    : new paypal.core.SandboxEnvironment(
        process.env.PAYPAL_CLIENT_ID,
        process.env.PAYPAL_SECRET
      );

const client = new paypal.core.PayPalHttpClient(environment);

// Razorpay Setup
const razorpay = new (require("razorpay"))({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Helper: Get PayPal Access Token
const getPayPalAccessToken = async () => {
  const auth = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`
  ).toString("base64");
  const response = await fetch(
    "https://api-m.sandbox.paypal.com/v1/oauth2/token",
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    }
  );

  const data = await response.json();
  if (!data.access_token) {
    throw new Error("Failed to get PayPal access token");
  }
  return data.access_token;
};

// CREATE PAYPAL SUBSCRIPTION — 100% WORKING 2025
const createPayPalSubscription = async (req, res) => {
  const { packageId } = req.body;
  const user = req.user;

  try {
    const pricingPackage = await PricingPackage.findById(packageId);
    if (!pricingPackage || !pricingPackage.isActive) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid or inactive package" });
    }

    const planIdMap = {
      Silver: process.env.PAYPAL_PLAN_SILVER_ID,
      Gold: process.env.PAYPAL_PLAN_GOLD_ID,
      Platinum: process.env.PAYPAL_PLAN_PLATINUM_ID,
      Diamond: process.env.PAYPAL_PLAN_DIAMOND_ID,
    };

    const paypalPlanId = planIdMap[pricingPackage.name];
    if (!paypalPlanId) {
      return res
        .status(400)
        .json({
          success: false,
          message: "PayPal plan not configured for this package",
        });
    }

    const accessToken = await getPayPalAccessToken();

    const response = await fetch(
      "https://api-m.sandbox.paypal.com/v1/billing/subscriptions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          plan_id: paypalPlanId,
          subscriber: {
            name: {
              given_name: user.full_name.split(" ")[0] || "User",
              surname: user.full_name.split(" ").slice(1).join(" ") || "Member",
            },
            email_address: user.email,
          },
          application_context: {
            brand_name: "UrbanCitations",
            locale: "en-IN",
            shipping_preference: "NO_SHIPPING",
            user_action: "SUBSCRIBE_NOW",
            return_url: `${process.env.FRONTEND_URL}/subscription/success`,
            cancel_url: `${process.env.FRONTEND_URL}/subscription/cancel`,
          },
        }),
      }
    );

    const subscription = await response.json();

    if (!response.ok) {
      console.error("PayPal Subscription Error:", subscription);
      return res.status(400).json({
        success: false,
        message: subscription.message || "Failed to create PayPal subscription",
      });
    }

    await User.findByIdAndUpdate(user._id, {
      "subscription.package": pricingPackage._id,
      "subscription.packageName": pricingPackage.name,
      "subscription.paypalSubscriptionId": subscription.id,
      "subscription.status": "pending",
      "subscription.paymentMethod": "paypal",
      "subscription.startDate": new Date(),
      "subscription.nextBillingDate": null,
    });

    const approvalLink = subscription.links.find(
      (link) => link.rel === "approve"
    )?.href;

    res.json({
      success: true,
      approvalUrl: approvalLink,
      subscriptionId: subscription.id,
    });
  } catch (error) {
    console.error("PayPal Create Error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// PAYPAL WEBHOOK — FULLY VERIFIED
const handlePayPalWebhook = async (req, res) => {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;

  try {
    const headers = req.headers;
    const payload = req.body;

    const verificationRequest =
      new paypal.notifications.WebhooksVerifySignatureRequest();
    verificationRequest.headers = {
      "paypal-auth-algo": headers["paypal-auth-algo"],
      "paypal-cert-url": headers["paypal-cert-url"],
      "paypal-transmission-id": headers["paypal-transmission-id"],
      "paypal-transmission-sig": headers["paypal-transmission-sig"],
      "paypal-transmission-time": headers["paypal-transmission-time"],
    };

    verificationRequest.requestBody({
      transmission_id: headers["paypal-transmission-id"],
      transmission_time: headers["paypal-transmission-time"],
      cert_url: headers["paypal-cert-url"],
      auth_algo: headers["paypal-auth-algo"],
      transmission_sig: headers["paypal-transmission-sig"],
      webhook_id: webhookId,
      webhook_event: payload,
    });

    const verificationResponse = await client.execute(verificationRequest);

    if (verificationResponse.result.verification_status !== "SUCCESS") {
      console.warn("Invalid PayPal webhook signature");
      return res.status(400).send("Invalid signature");
    }

    const eventType = payload.event_type;
    const subId = payload.resource?.id;

    if (!subId) {
      return res.status(200).send("OK");
    }

    switch (eventType) {
      case "BILLING.SUBSCRIPTION.ACTIVATED":
      case "BILLING.SUBSCRIPTION.RENEWED":
        await User.updateOne(
          { "subscription.paypalSubscriptionId": subId },
          {
            "subscription.status": "active",
            "subscription.nextBillingDate": payload.resource.billing_info
              ?.next_billing_time
              ? new Date(payload.resource.billing_info.next_billing_time)
              : null,
          }
        );
        break;

      case "BILLING.SUBSCRIPTION.CANCELLED":
        await User.updateOne(
          { "subscription.paypalSubscriptionId": subId },
          {
            "subscription.status": "canceled",
            "subscription.endDate": new Date(),
          }
        );
        break;

      case "BILLING.SUBSCRIPTION.EXPIRED":
        await User.updateOne(
          { "subscription.paypalSubscriptionId": subId },
          { "subscription.status": "expired" }
        );
        break;
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("PayPal Webhook Error:", error);
    res.status(500).send("Webhook processing failed");
  }
};

// RAZORPAY SUBSCRIPTION
const createRazorpaySubscription = async (req, res) => {
  const { packageId } = req.body;
  const user = req.user;

  try {
    const pricingPackage = await PricingPackage.findById(packageId);
    if (!pricingPackage || !pricingPackage.isActive) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid or inactive package" });
    }

    const planId =
      process.env[`RAZORPAY_PLAN_${pricingPackage.name.toUpperCase()}_ID`];
    if (!planId) {
      return res
        .status(400)
        .json({ success: false, message: "Razorpay plan not configured" });
    }

    const subscription = await razorpay.subscriptions.create({
      plan_id: planId,
      total_count: 120,
      customer_notify: 1,
      notes: {
        userId: user._id.toString(),
        packageName: pricingPackage.name,
      },
    });

    await User.findByIdAndUpdate(user._id, {
      "subscription.package": pricingPackage._id,
      "subscription.packageName": pricingPackage.name,
      "subscription.razorpaySubscriptionId": subscription.id,
      "subscription.status": "pending",
      "subscription.paymentMethod": "razorpay",
      "subscription.startDate": new Date(),
    });

    res.json({
      success: true,
      subscriptionId: subscription.id,
      short_url: subscription.short_url,
    });
  } catch (error) {
    console.error("Razorpay Subscription Error:", error);
    res
      .status(500)
      .json({
        success: false,
        message: "Failed to create Razorpay subscription",
      });
  }
};

// RAZORPAY WEBHOOK
const verifyRazorpayWebhook = async (req, res) => {
  const signature = req.headers["x-razorpay-signature"];
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

  if (!signature || !webhookSecret) {
    return res.status(400).send("Missing signature or secret");
  }

  const shasum = crypto.createHmac("sha256", webhookSecret);
  shasum.update(req.rawBody);
  const digest = shasum.digest("hex");

  if (signature !== digest) {
    console.warn("Invalid Razorpay webhook signature");
    return res.status(400).send("Invalid signature");
  }

  const event = req.body;
  const subId = event.payload?.subscription?.entity?.id;

  if (event.event === "subscription.charged") {
    await User.updateOne(
      { "subscription.razorpaySubscriptionId": subId },
      {
        "subscription.status": "active",
        "subscription.nextBillingDate": new Date(
          Date.now() + 30 * 24 * 60 * 60 * 1000
        ),
      }
    );
  }

  if (["subscription.cancelled", "subscription.halted"].includes(event.event)) {
    await User.updateOne(
      { "subscription.razorpaySubscriptionId": subId },
      { "subscription.status": "canceled", "subscription.endDate": new Date() }
    );
  }

  res.json({ status: "ok" });
};

// USER: Get My Subscription
const getMySubscription = async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .select("subscription full_name email")
      .populate("subscription.package", "name priceINR features");

    res.json({
      success: true,
      subscription: user.subscription || {},
      hasActiveSubscription: user.subscription?.status === "active",
      isPaidSubscriber:
        ["Gold", "Platinum", "Diamond"].includes(
          user.subscription?.packageName
        ) && user.subscription?.status === "active",
    });
  } catch (error) {
    console.error("Get Subscription Error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// USER: Cancel Subscription
const cancelSubscription = async (req, res) => {
  const user = req.user;

  try {
    if (
      user.subscription?.paymentMethod === "paypal" &&
      user.subscription.paypalSubscriptionId
    ) {
      const accessToken = await getPayPalAccessToken();
      await fetch(
        `https://api-m.sandbox.paypal.com/v1/billing/subscriptions/${user.subscription.paypalSubscriptionId}/cancel`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ reason: "User requested cancellation" }),
        }
      );
    }

    await User.findByIdAndUpdate(user._id, {
      "subscription.status": "canceled",
      "subscription.endDate": new Date(),
    });

    res.json({ success: true, message: "Subscription canceled successfully" });
  } catch (error) {
    console.error("Cancel Error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to cancel subscription" });
  }
};

// USER: Reactivate Subscription
const reactivateSubscription = async (req, res) => {
  const user = req.user;

  try {
    if (
      user.subscription?.paymentMethod === "paypal" &&
      user.subscription.paypalSubscriptionId
    ) {
      const accessToken = await getPayPalAccessToken();
      await fetch(
        `https://api-m.sandbox.paypal.com/v1/billing/subscriptions/${user.subscription.paypalSubscriptionId}/activate`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ reason: "User requested reactivation" }),
        }
      );
    }

    await User.findByIdAndUpdate(user._id, {
      "subscription.status": "active",
      "subscription.endDate": null,
    });

    res.json({
      success: true,
      message: "Subscription reactivated successfully",
    });
  } catch (error) {
    console.error("Reactivate Error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to reactivate subscription" });
  }
};

// ADMIN: Get All Subscriptions
const getAllSubscriptions = async (req, res) => {
  try {
    const users = await User.find({
      "subscription.status": { $in: ["active", "pending", "canceled"] },
    })
      .select("full_name email subscription")
      .populate("subscription.package", "name priceINR");

    res.json({ success: true, subscriptions: users });
  } catch (error) {
    console.error("Admin Subscriptions Error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

module.exports = {
  createPayPalSubscription,
  handlePayPalWebhook,
  createRazorpaySubscription,
  verifyRazorpayWebhook,
  getMySubscription,
  cancelSubscription,
  reactivateSubscription,
  getAllSubscriptions,
};
