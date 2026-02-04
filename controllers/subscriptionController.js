const Business = require("../models/Business");
const PricingPackage = require("../models/PricingPackage");
const paypal = require("@paypal/checkout-server-sdk");
const crypto = require("crypto");
const fetch = require("node-fetch");
const { notifyAdmins } = require("../helpers/notificationHelper");
const { addJob } = require("../utils/queue");

// PayPal Environment
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

const paypalClient = new paypal.core.PayPalHttpClient(environment);

// Razorpay Instance
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
    process.env.NODE_ENV === "production"
      ? "https://api-m.paypal.com/v1/oauth2/token"
      : "https://api-m.sandbox.paypal.com/v1/oauth2/token",
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
  if (!data.access_token) throw new Error("Failed to get PayPal access token");
  return data.access_token;
};

// CREATE PAYPAL SUBSCRIPTION (Per Business)
const createPayPalSubscription = async (req, res) => {
  const { businessId, packageId } = req.body;
  const userId = req.user.id;

  try {
    if (!businessId || !packageId) {
      return res
        .status(400)
        .json({
          success: false,
          message: "businessId and packageId are required",
        });
    }

    const business = await Business.findOne({ _id: businessId, userId });
    if (!business) {
      return res
        .status(404)
        .json({
          success: false,
          message: "Business not found or you don't own it",
        });
    }

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
              given_name: business.businessName.slice(0, 20) || "Business",
            },
            email_address: req.user.email,
          },
          application_context: {
            brand_name: "UrbanCitations",
            locale: "en-IN",
            shipping_preference: "NO_SHIPPING",
            user_action: "SUBSCRIBE_NOW",
            return_url: `${process.env.FRONTEND_URL}/subscription/success?businessId=${businessId}`,
            cancel_url: `${process.env.FRONTEND_URL}/subscription/cancel`,
          },
        }),
      }
    );

    const subscription = await response.json();

    if (!response.ok) {
      console.error("PayPal Error:", subscription);
      return res
        .status(400)
        .json({
          success: false,
          message: subscription.message || "PayPal subscription failed",
        });
    }

    const approvalLink = subscription.links.find(
      (link) => link.rel === "approve"
    )?.href;

    // Save pending subscription on business
    business.subscription = {
      packageId: pricingPackage._id,
      packageName: pricingPackage.name,
      paypalSubscriptionId: subscription.id,
      status: "pending",
      paymentGateway: "paypal",
      startDate: new Date(),
    };
    await business.save();

    res.json({
      success: true,
      approvalUrl: approvalLink,
      subscriptionId: subscription.id,
    });
  } catch (error) {
    console.error("createPayPalSubscription Error:", error);
    res
      .status(500)
      .json({
        success: false,
        message: "Server error during PayPal subscription",
      });
  }
};

// PAYPAL WEBHOOK HANDLER
const handlePayPalWebhook = async (req, res) => {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;

  try {
    const headers = req.headers;
    const payload = req.body;

    // Verify signature (optional but recommended)
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

    const verificationResponse = await paypalClient.execute(
      verificationRequest
    );
    if (verificationResponse.result.verification_status !== "SUCCESS") {
      return res.status(400).send("Invalid webhook signature");
    }

    const eventType = payload.event_type;
    const subId = payload.resource?.id;

    if (!subId) return res.status(200).send("OK");

    const business = await Business.findOne({
      "subscription.paypalSubscriptionId": subId,
    });
    if (!business) return res.status(200).send("Business not found");

    switch (eventType) {
      case "BILLING.SUBSCRIPTION.ACTIVATED":
      case "BILLING.SUBSCRIPTION.RENEWED":
        business.subscription.status = "active";
        business.subscription.nextBillingDate = payload.resource.billing_info
          ?.next_billing_time
          ? new Date(payload.resource.billing_info.next_billing_time)
          : null;

        // Notify Admins
        await notifyAdmins({
          title: "New Package Purchased (PayPal)",
          description: `${business.businessName} has purchased the ${business.subscription.packageName} package.`,
          link: "/all-business",
          category: "subscription",
        });

        // Add purchase email job to queue
        await addJob("purchase-email", {
          businessId: business._id,
          packageDetails: {
            packageName: business.subscription.packageName,
          },
        });
        break;
      case "BILLING.SUBSCRIPTION.CANCELLED":
      case "BILLING.SUBSCRIPTION.EXPIRED":
        business.subscription.status = "canceled";
        business.subscription.endDate = new Date();
        break;
      case "BILLING.SUBSCRIPTION.SUSPENDED":
        business.subscription.status = "suspended";
        break;
    }

    await business.save();
    res.status(200).send("OK");
  } catch (error) {
    console.error("PayPal Webhook Error:", error);
    res.status(500).send("Webhook processing failed");
  }
};

// CREATE RAZORPAY SUBSCRIPTION (Per Business)
const createRazorpaySubscription = async (req, res) => {
  const { businessId, packageId } = req.body;
  const userId = req.user.id;

  try {
    if (!businessId || !packageId) {
      return res
        .status(400)
        .json({ success: false, message: "businessId and packageId required" });
    }

    const business = await Business.findOne({ _id: businessId, userId });
    if (!business) {
      return res
        .status(404)
        .json({ success: false, message: "Business not found" });
    }

    const pricingPackage = await PricingPackage.findById(packageId);
    if (!pricingPackage || !pricingPackage.isActive) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid package" });
    }

    // --- PREVENT OVERWRITING ACTIVE SUB WITH SAME NAME ---
    if (business.subscription?.status === "active" && business.subscription.packageName === pricingPackage.name) {
      return res.status(400).json({ 
        success: false, 
        message: `You are already subscribed to the ${pricingPackage.name} plan.` 
      });
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
      addons: [],
      notes: {
        businessId: businessId.toString(),
        businessName: business.businessName,
      },
    });

    business.subscription = {
      packageId: pricingPackage._id,
      packageName: pricingPackage.name,
      razorpaySubscriptionId: subscription.id,
      status: "pending",
      paymentGateway: "razorpay",
      startDate: new Date(),
    };
    await business.save();

    res.json({
      success: true,
      subscriptionId: subscription.id,
      short_url: subscription.short_url,
      key_id: process.env.RAZORPAY_KEY_ID,
    });
  } catch (error) {
    console.error("Razorpay Subscription Error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to create subscription" });
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
  shasum.update(req.rawBody || JSON.stringify(req.body));
  const digest = shasum.digest("hex");

  if (signature !== digest) {
    console.warn("Invalid Razorpay webhook signature");
    return res.status(400).send("Invalid signature");
  }

  const event = req.body;
  const subId = event.payload?.subscription?.entity?.id;

  if (
    event.event === "subscription.charged" ||
    event.event === "subscription.activated"
  ) {
    const business = await Business.findOne({
      "subscription.razorpaySubscriptionId": subId,
    });
    if (business) {
      business.subscription.status = "active";
      business.subscription.nextBillingDate = new Date(
        Date.now() + 30 * 24 * 60 * 60 * 1000
      );
      await business.save();

      // Notify Admins
      await notifyAdmins({
        title: "New Package Purchased (Razorpay)",
        description: `${business.businessName} has purchased the ${business.subscription.packageName} package.`,
        link: "/all-business",
        category: "subscription",
      });

      // Add purchase email job to queue
      await addJob("purchase-email", {
        businessId: business._id,
        packageDetails: {
          packageName: business.subscription.packageName,
        },
      });
    }
  }

  if (["subscription.cancelled", "subscription.halted"].includes(event.event)) {
    await Business.updateOne(
      { "subscription.razorpaySubscriptionId": subId },
      {
        "subscription.status": "canceled",
        "subscription.endDate": new Date(),
      }
    );
  }

  res.json({ status: "ok" });
};

// MANUALLY VERIFY SUBSCRIPTION FROM FRONTEND (Immediate Activation)
const verifyRazorpaySubscription = async (req, res) => {
  const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature, businessId } = req.body;

  try {
    const secret = process.env.RAZORPAY_KEY_SECRET;
    const body = razorpay_payment_id + "|" + razorpay_subscription_id;

    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(body.toString())
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ success: false, message: "Invalid signature" });
    }

    const business = await Business.findOne({ _id: businessId, userId: req.user.id });
    if (!business) {
        return res.status(404).json({ success: false, message: "Business not found" });
    }

    business.subscription.status = "active";
    business.subscription.nextBillingDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await business.save();

    // Notify Admins & Send Email
    await notifyAdmins({
      title: "Subscription Verified (Manual)",
      description: `${business.businessName} has activeated ${business.subscription.packageName}.`,
      link: "/all-business",
      category: "subscription",
    });

    await addJob("purchase-email", {
      businessId: business._id,
      packageDetails: { packageName: business.subscription.packageName },
    });

    res.json({ success: true, message: "Subscription activated successfully" });
  } catch (error) {
    console.error("Manual Verification Error:", error);
    res.status(500).json({ success: false, message: "Verification failed" });
  }
};

// GET BUSINESS SUBSCRIPTION
const getBusinessSubscription = async (req, res) => {
  try {
    const { businessId } = req.params;
    const userId = req.user.id;

    const business = await Business.findOne({ _id: businessId, userId })
      .select("businessName subscription")
      .populate("subscription.packageId", "name priceINR features");

    if (!business) {
      return res
        .status(404)
        .json({ success: false, message: "Business not found" });
    }

    const sub = business.subscription || {};
    res.json({
      success: true,
      businessName: business.businessName,
      subscription: sub,
      isActive: sub.status === "active",
      isPremium:
        ["Gold", "Platinum", "Diamond"].includes(sub.packageName) &&
        sub.status === "active",
    });
  } catch (error) {
    console.error("Get Business Subscription Error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// CANCEL BUSINESS SUBSCRIPTION
const cancelBusinessSubscription = async (req, res) => {
  try {
    const { businessId } = req.params;
    const userId = req.user.id;

    const business = await Business.findOne({ _id: businessId, userId });
    if (!business || !business.subscription) {
      return res
        .status(404)
        .json({ success: false, message: "No active subscription found" });
    }

    if (
      business.subscription.paymentGateway === "razorpay" &&
      business.subscription.razorpaySubscriptionId
    ) {
      await razorpay.subscriptions.cancel(
        business.subscription.razorpaySubscriptionId
      );
    }

    if (
      business.subscription.paymentGateway === "paypal" &&
      business.subscription.paypalSubscriptionId
    ) {
      const token = await getPayPalAccessToken();
      await fetch(
        `https://api-m.sandbox.paypal.com/v1/billing/subscriptions/${business.subscription.paypalSubscriptionId}/cancel`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ reason: "User requested cancellation" }),
        }
      );
    }

    business.subscription.status = "canceled";
    business.subscription.endDate = new Date();
    await business.save();

    res.json({ success: true, message: "Subscription canceled successfully" });
  } catch (error) {
    console.error("Cancel Subscription Error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to cancel subscription" });
  }
};

// REACTIVATE BUSINESS SUBSCRIPTION
const reactivateBusinessSubscription = async (req, res) => {
  try {
    const { businessId } = req.params;
    const userId = req.user.id;

    const business = await Business.findOne({ _id: businessId, userId });
    if (!business || !business.subscription) {
      return res
        .status(404)
        .json({ success: false, message: "No subscription found" });
    }

    if (
      business.subscription.paymentGateway === "paypal" &&
      business.subscription.paypalSubscriptionId
    ) {
      const token = await getPayPalAccessToken();
      await fetch(
        `https://api-m.sandbox.paypal.com/v1/billing/subscriptions/${business.subscription.paypalSubscriptionId}/activate`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ reason: "User requested reactivation" }),
        }
      );
    }

    business.subscription.status = "active";
    business.subscription.endDate = null;
    await business.save();

    res.json({
      success: true,
      message: "Subscription reactivated successfully",
    });
  } catch (error) {
    console.error("Reactivate Error:", error);
    res.status(500).json({ success: false, message: "Failed to reactivate" });
  }
};

// ADMIN: Get All Active Subscriptions
const getAllBusinessSubscriptions = async (req, res) => {
  try {
    const businesses = await Business.find({
      "subscription.status": { $in: ["active", "pending"] },
    })
      .select("businessName subscription userId createdAt")
      .populate("subscription.packageId", "name priceINR")
      .populate("userId", "full_name email mobile");

    res.json({
      success: true,
      total: businesses.length,
      subscriptions: businesses,
    });
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
  verifyRazorpaySubscription,
  getBusinessSubscription,
  cancelBusinessSubscription,
  reactivateBusinessSubscription,
  getAllBusinessSubscriptions,
};
