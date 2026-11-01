const mongoose = require('mongoose');
const { Schema } = mongoose;

// Fixed paid plans (a business without an active one is on "Free").
const PACKAGE_NAMES = ['Basic', 'Silver', 'Gold', 'Premium'];
const REMINDER_KEYS = ['3d', '2d', '1d', '30m', '10m'];

const FeatureItemSchema = new Schema({
  label: { type: String, required: true, trim: true, maxlength: 120 },
  // "yes" / "no", or a short value such as "30", "Up to 10", "Monthly", "2 / mo".
  value: { type: String, required: true, trim: true, maxlength: 40 }
}, { _id: false });

const FeatureGroupSchema = new Schema({
  title: { type: String, required: true, trim: true, maxlength: 80 },
  items: { type: [FeatureItemSchema], default: [] }
}, { _id: false });

// What the plan's customer emails include; see services/planEntitlements.js.
const EntitlementsSchema = new Schema({
  ownSender: { type: Boolean },
  bookingEmails: { type: Boolean },
  bookingReminders: { type: [{ type: String, enum: REMINDER_KEYS }], default: undefined },
  customTemplates: { type: Boolean },
  crmLeadEmails: { type: Boolean },
  aiEmails: { type: Boolean },
  journeys: { type: Boolean },
  googleBusiness: { type: Boolean }
}, { _id: false });

const PricingPackageSchema = new Schema({
  name: {
    type: String,
    required: true,
    enum: PACKAGE_NAMES,
    unique: true
  },
  // 0 means "not priced in this currency yet": the pricing page shows USD instead.
  priceINR: {
    type: Number,
    required: true,
    min: 0
  },
  priceUSD: {
    type: Number,
    required: true,
    min: 0
  },
  priceGBP: {
    type: Number,
    required: true,
    min: 0
  },
  billingPeriod: {
    type: String,
    enum: ['month', 'year'],
    default: 'month'
  },
  sortOrder: {
    type: Number,
    default: 0
  },
  featureGroups: {
    type: [FeatureGroupSchema],
    default: []
  },
  entitlements: {
    type: EntitlementsSchema,
    default: undefined
  },
  // Legacy boolean feature flags of the old Silver/Gold/Platinum/Diamond packages.
  features: {
    type: Schema.Types.Mixed,
    default: {}
  },
  featureIcons: {
    type: Map,
    of: String,
    default: {}
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('PricingPackage', PricingPackageSchema);
module.exports.PACKAGE_NAMES = PACKAGE_NAMES;
module.exports.REMINDER_KEYS = REMINDER_KEYS;
