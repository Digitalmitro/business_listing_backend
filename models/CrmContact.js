// backend/models/CrmContact.js
const mongoose = require("mongoose");

const addressSchema = new mongoose.Schema(
  {
    street: { type: String, trim: true, default: "" },
    city: { type: String, trim: true, default: "" },
    state: { type: String, trim: true, default: "" },
    zip: { type: String, trim: true, default: "" },
    country: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const CONTACT_SOURCES = [
  "Website",
  "Referral",
  "Cold Call",
  "Social Media",
  "Advertisement",
  "Event",
  "Other",
  "Listing Visitor",
  "Import",
  "Booking",
  "Enquiry",
  "Lead",
  "",
];
const LIFECYCLE_STAGES = ["subscriber", "engaged", "lead", "customer", "inactive"];
const EMAIL_STATUSES = ["subscribed", "unsubscribed", "bounced"];
/** opt_in: gave their email on the listing; customer/lead: existing relationship; *_confirmed: owner confirmed permission. */
const CONSENT_BASES = ["opt_in", "customer", "lead", "import_confirmed", "manual_confirmed", "unknown"];
const MARKETING_CONSENT_BASES = ["opt_in", "customer", "lead", "import_confirmed", "manual_confirmed"];

const interestSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["business", "service"], required: true },
    name: { type: String, trim: true, maxlength: 120, required: true },
    refId: { type: String, default: "" },
    views: { type: Number, default: 1 },
    firstViewedAt: { type: Date, default: Date.now },
    lastViewedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const crmContactSchema = new mongoose.Schema(
  {
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      default: null,
      index: true,
    },
    /** Optional: contacts captured from a listing or an import may only have an email. */
    name: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    company: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    email: {
      type: String,
      lowercase: true,
      trim: true,
      default: "",
      index: true,
    },
    phone: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    alternatePhone: {
      type: String,
      trim: true,
      default: "",
    },
    website: {
      type: String,
      trim: true,
      default: "",
    },
    address: {
      type: addressSchema,
      default: () => ({ street: "", city: "", state: "", zip: "", country: "" }),
    },
    industry: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    source: {
      type: String,
      enum: CONTACT_SOURCES,
      default: "Other",
      index: true,
    },
    assignedUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    notes: {
      type: String,
      default: "",
    },

    // ── Engagement (AI email journeys) ─────────────────────────────────────
    /**
     * `${businessId}:${email}` for contacts that belong to a business and have an
     * email. Unique (partial index), so one person is one contact per business.
     * Kept separate from `email` so legacy duplicates never block the index build.
     */
    emailKey: { type: String, default: undefined },
    /** Customer account behind this contact, when known. */
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    /** The contact's lead in this business's pipeline, when linked. */
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: "CrmLead", default: null },
    tags: { type: [String], default: [] },
    /** subscriber → engaged → lead → customer; inactive after a long silence. */
    lifecycle: { type: String, enum: LIFECYCLE_STAGES, default: "subscriber", index: true },
    /** Marketing email status for this business (global opt-outs live in UnsubscribedEmail). */
    emailStatus: { type: String, enum: EMAIL_STATUSES, default: "subscribed", index: true },
    emailStatusChangedAt: { type: Date, default: null },
    /**
     * Why this business may email the contact. Only eligible bases enter journeys;
     * `unknown` (e.g. legacy or manually added contacts) never does until the owner confirms.
     */
    consent: {
      basis: { type: String, enum: CONSENT_BASES, default: "unknown" },
      capturedAt: { type: Date, default: null },
    },
    /** Anonymous first-party visitor ids linked when the visitor gave their email. */
    visitorIds: { type: [String], default: undefined, select: false },
    /** Most recent things the contact looked at on this business (capped). */
    interests: { type: [interestSchema], default: [] },
    bookings: {
      count: { type: Number, default: 0 },
      lastBookedAt: { type: Date, default: null },
      nextBookingAt: { type: Date, default: null },
      lastServiceName: { type: String, default: "" },
      lastStartedAt: { type: Date, default: null },
    },
    engagement: {
      lastActivityAt: { type: Date, default: null },
      lastActivityType: { type: String, default: "" },
      activityCount: { type: Number, default: 0 },
      emailsSent: { type: Number, default: 0 },
      lastEmailSentAt: { type: Date, default: null },
      lastClickedAt: { type: Date, default: null },
      lastRepliedAt: { type: Date, default: null },
      /** Last time the inactivity sweep looked at this contact. */
      inactiveCheckedAt: { type: Date, default: null },
    },
    /** Result of the post-import review: enrolled into a journey, or waiting for activity. */
    triage: {
      status: { type: String, enum: ["pending", "enrolled", "waiting", "skipped", null], default: null },
      importId: { type: mongoose.Schema.Types.ObjectId, default: null },
      reason: { type: String, default: "" },
      decidedAt: { type: Date, default: null },
      decidedBy: { type: String, enum: ["ai", "rules", null], default: null },
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Index for fast multi-tenant searches across core fields
crmContactSchema.index({ ownerId: 1, name: 1, company: 1 });

// Full-text search index across name, company, email, and notes
crmContactSchema.index({ name: "text", company: "text", email: "text", notes: "text" }, { name: "contact_text_index" });

// One contact per business and email (only documents written by the engagement code carry emailKey).
crmContactSchema.index(
  { emailKey: 1 },
  { unique: true, partialFilterExpression: { emailKey: { $type: "string" } } }
);
crmContactSchema.index({ businessId: 1, phone: 1 });
crmContactSchema.index({ businessId: 1, visitorIds: 1 }, { sparse: true });
crmContactSchema.index({ businessId: 1, lifecycle: 1, "engagement.lastActivityAt": -1 });
crmContactSchema.index({ businessId: 1, tags: 1 });
// Sweeps for abandoned bookings and inactive contacts.
crmContactSchema.index({ businessId: 1, "bookings.lastStartedAt": -1 });

module.exports = mongoose.model("CrmContact", crmContactSchema);
module.exports.CONTACT_SOURCES = CONTACT_SOURCES;
module.exports.LIFECYCLE_STAGES = LIFECYCLE_STAGES;
module.exports.EMAIL_STATUSES = EMAIL_STATUSES;
module.exports.CONSENT_BASES = CONSENT_BASES;
module.exports.MARKETING_CONSENT_BASES = MARKETING_CONSENT_BASES;
