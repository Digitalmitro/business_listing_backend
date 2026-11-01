const Business = require("../models/Business");
const PricingPackage = require("../models/PricingPackage");
const paypal = require("@paypal/checkout-server-sdk");
const crypto = require("crypto");
const fetch = require("node-fetch");
const { notifyAdmins } = require("../helpers/notificationHelper");
const { addJob } = require("../utils/queue");
const plans = require("../services/planEntitlements");

// ── Subscription state helpers ───────────────────────────────────────────────
// A checkout is stored in subscription.pending; the plan in force only changes
// when the payment gateway confirms THAT subscription id. (Previously the ids were
// written to fields the schema doesn't have, so webhooks could never match a
// business, and an abandoned upgrade wiped the active plan.)

function setPending(business, pricingPackage, subscriptionId, gateway) {
  if (!business.subscription) business.subscription = {};
  business.subscription.pending = {
    packageId: pricingPackage._id,
    packageName: pricingPackage.name,
    subscriptionId,
    paymentGateway: gateway,
    createdAt: new Date(),
  };
}

/** Makes the confirmed subscription the plan in force. Returns false if the id is unknown. */
function promotePending(business, subscriptionId, { nextBillingDate = null } = {}) {
  const sub = business.subscription || {};
  if (sub.pending?.subscriptionId && sub.pending.subscriptionId === subscriptionId) {
    business.subscription.packageId = sub.pending.packageId;
    business.subscription.packageName = sub.pending.packageName;
    business.subscription.subscriptionId = sub.pending.subscriptionId;
    business.subscription.paymentGateway = sub.pending.paymentGateway;
    business.subscription.startDate = new Date();
    business.subscription.endDate = null;
    business.subscription.pending = { packageId: null, packageName: null, subscriptionId: null, paymentGateway: null, createdAt: null };
  } else if (sub.subscriptionId !== subscriptionId) {
    return false;
  }
  business.subscription.status = "active";
  business.subscription.nextBillingDate = nextBillingDate;
  return true;
}

function findBySubscriptionId(subscriptionId) {
  if (!subscriptionId) return null;
  return Business.findOne({
    $or: [{ "subscription.subscriptionId": subscriptionId }, { "subscription.pending.subscriptionId": subscriptionId }],
  });
}

function gatewayPlanId(gateway, packageName) {
  return process.env[`${gateway}_PLAN_${String(packageName).toUpperCase()}_ID`];
}

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

// Initialize Razorpay only when a Razorpay operation is requested. Optional
// payment configuration must not prevent the rest of the API from starting.
const getRazorpayClient = () => {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    const error = new Error("Razorpay is not configured");
    error.code = "PAYMENT_PROVIDER_NOT_CONFIGURED";
    throw error;
  }

  const Razorpay = require("razorpay");
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
};

// Helper: Get PayPal Access Token
// One base URL for every PayPal call (token AND subscriptions); previously the
// subscription calls were always sent to the sandbox, even in production.
function paypalApiBase() {
  return process.env.PAYPAL_API_BASE || (process.env.NODE_ENV === "production" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com");
}

const getPayPalAccessToken = async () => {
  const auth = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`
  ).toString("base64");
  const response = await fetch(
    `${paypalApiBase()}/v1/oauth2/token`,
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

    // PAYPAL_PLAN_BASIC_ID, PAYPAL_PLAN_SILVER_ID, PAYPAL_PLAN_GOLD_ID, PAYPAL_PLAN_PREMIUM_ID
    const paypalPlanId = gatewayPlanId("PAYPAL", pricingPackage.name);
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
      `${paypalApiBase()}/v1/billing/subscriptions`,
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

    // The current plan stays in force until PayPal confirms this subscription.
    setPending(business, pricingPackage, subscription.id, "paypal");
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

    const business = await findBySubscriptionId(subId);
    if (!business) return res.status(200).send("Business not found");
    const isCurrent = business.subscription?.subscriptionId === subId;

    switch (eventType) {
      case "BILLING.SUBSCRIPTION.ACTIVATED":
      case "BILLING.SUBSCRIPTION.RENEWED":
        promotePending(business, subId, {
          nextBillingDate: payload.resource.billing_info?.next_billing_time
            ? new Date(payload.resource.billing_info.next_billing_time)
            : null,
        });

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
        if (isCurrent) {
          business.subscription.status = "canceled";
          business.subscription.endDate = new Date();
        } else {
          business.subscription.pending = { packageId: null, packageName: null, subscriptionId: null, paymentGateway: null, createdAt: null };
        }
        break;
      case "BILLING.SUBSCRIPTION.SUSPENDED":
        // "suspended" isn't a valid status (the save used to fail); a suspended
        // subscription (failed payment) no longer grants the plan.
        if (isCurrent) business.subscription.status = "inactive";
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
    const razorpay = getRazorpayClient();

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

    // RAZORPAY_PLAN_BASIC_ID, RAZORPAY_PLAN_SILVER_ID, RAZORPAY_PLAN_GOLD_ID, RAZORPAY_PLAN_PREMIUM_ID
    const planId = gatewayPlanId("RAZORPAY", pricingPackage.name);
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

    // The current plan stays in force until Razorpay confirms this subscription.
    setPending(business, pricingPackage, subscription.id, "razorpay");
    await business.save();

    res.json({
      success: true,
      subscriptionId: subscription.id,
      short_url: subscription.short_url,
      key_id: process.env.RAZORPAY_KEY_ID,
    });
  } catch (error) {
    console.error("Razorpay Subscription Error:", error);
    if (error.code === "PAYMENT_PROVIDER_NOT_CONFIGURED") {
      return res.status(503).json({ success: false, message: error.message });
    }
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
    const business = await findBySubscriptionId(subId);
    if (business && promotePending(business, subId, { nextBillingDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) })) {
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

  if (subId && ["subscription.cancelled", "subscription.halted"].includes(event.event)) {
    await Business.updateOne(
      { "subscription.subscriptionId": subId },
      { $set: { "subscription.status": "canceled", "subscription.endDate": new Date() } }
    );
    await Business.updateOne(
      { "subscription.pending.subscriptionId": subId },
      { $set: { "subscription.pending": { packageId: null, packageName: null, subscriptionId: null, paymentGateway: null, createdAt: null } } }
    );
  }

  res.json({ status: "ok" });
};

// MANUALLY VERIFY SUBSCRIPTION FROM FRONTEND (Immediate Activation)
const verifyRazorpaySubscription = async (req, res) => {
  const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature, businessId } = req.body;

  try {
    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!secret) {
      return res.status(503).json({
        success: false,
        message: "Razorpay is not configured",
      });
    }
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

    // The signed payment must be for the subscription this business started;
    // otherwise a cheaper plan's payment could activate a pricier one.
    if (!promotePending(business, razorpay_subscription_id, { nextBillingDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) })) {
      return res.status(400).json({ success: false, message: "This payment is not for this business's subscription" });
    }
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
    const { planName, entitlements } = await plans.getPlanEntitlements(business);
    res.json({
      success: true,
      businessName: business.businessName,
      subscription: sub,
      isActive: planName !== "Free",
      planName,
      entitlements,
      isPremium: planName !== "Free",
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
      business.subscription.subscriptionId
    ) {
      const razorpay = getRazorpayClient();
      await razorpay.subscriptions.cancel(
        business.subscription.subscriptionId
      );
    }

    if (
      business.subscription.paymentGateway === "paypal" &&
      business.subscription.subscriptionId
    ) {
      const token = await getPayPalAccessToken();
      await fetch(
        `${paypalApiBase()}/v1/billing/subscriptions/${business.subscription.subscriptionId}/cancel`,
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
    if (error.code === "PAYMENT_PROVIDER_NOT_CONFIGURED") {
      return res.status(503).json({ success: false, message: error.message });
    }
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
      business.subscription.subscriptionId
    ) {
      const token = await getPayPalAccessToken();
      await fetch(
        `${paypalApiBase()}/v1/billing/subscriptions/${business.subscription.subscriptionId}/activate`,
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
    if (!req.isAdmin) return res.status(403).json({ success: false, message: "Admin access required" });
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

// ADMIN: SET A BUSINESS'S PLAN WITHOUT A GATEWAY (offline payment, complimentary plan)
// PATCH /api/subscription/admin/business/:businessId  { packageName: "Basic"|"Silver"|"Gold"|"Premium"|"Free", endDate? }
const adminSetBusinessPlan = async (req, res) => {
  try {
    if (!req.isAdmin) return res.status(403).json({ success: false, message: "Admin access required" });
    const { businessId } = req.params;
    const requested = String(req.body?.packageName || "").trim();
    const planName = plans.PLAN_NAMES.find((p) => p.toLowerCase() === requested.toLowerCase());
    if (!planName) {
      return res.status(400).json({ success: false, message: `packageName must be one of: ${plans.PLAN_NAMES.join(", ")}` });
    }
    let endDate = null;
    if (req.body?.endDate) {
      endDate = new Date(req.body.endDate);
      if (Number.isNaN(endDate.getTime()) || endDate.getTime() <= Date.now()) {
        return res.status(400).json({ success: false, message: "endDate must be a future date" });
      }
    }

    const business = await Business.findById(businessId).select("_id businessName subscription").lean();
    if (!business) return res.status(404).json({ success: false, message: "Business not found" });

    // Targeted update: a full document save would re-run unrelated validation (e.g. the
    // duplicate-phone rule on imported listings) and fail the plan change.
    let set;
    if (planName === "Free") {
      set = {
        "subscription.packageId": null,
        "subscription.packageName": "Free",
        "subscription.status": "inactive",
        "subscription.endDate": new Date(),
      };
    } else {
      const pricingPackage = await PricingPackage.findOne({ name: planName });
      if (!pricingPackage) return res.status(400).json({ success: false, message: `The ${planName} package doesn't exist yet. Create it in Packages first.` });
      set = {
        "subscription.packageId": pricingPackage._id,
        "subscription.packageName": pricingPackage.name,
        "subscription.status": "active",
        "subscription.paymentGateway": "manual",
        "subscription.subscriptionId": null,
        "subscription.startDate": new Date(),
        "subscription.endDate": endDate,
      };
    }
    await Business.updateOne({ _id: business._id }, { $set: set }, { runValidators: false });
    const updated = await Business.findById(business._id).select("businessName subscription").lean();
    business.subscription = updated.subscription;
    const { entitlements } = await plans.getPlanEntitlements(business);
    console.info("Admin set business plan", { adminId: String(req.user._id), businessId: String(business._id), planName, endDate });
    res.json({ success: true, message: `${business.businessName} is now on the ${planName} plan.`, planName, entitlements, subscription: business.subscription });
  } catch (error) {
    console.error("Admin Set Plan Error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

module.exports = {
  adminSetBusinessPlan,
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
