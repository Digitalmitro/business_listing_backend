const mongoose = require('mongoose');
const { Schema } = mongoose;

const PricingPackageSchema = new Schema({
  name: {
    type: String,
    required: true,
    enum: ['Silver', 'Gold', 'Platinum', 'Diamond'], // Fixed packages
    unique: true
  },
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
  features: {
    type: {
      searchVisibility: { type: Boolean, default: true },
      freeListing: { type: Boolean, default: true },
      reviewsAndRatings: { type: Boolean, default: true },
      businessDescription: { type: Boolean, default: true },
      businessHours: { type: Boolean, default: true },
      gallery: { type: Boolean, default: true },
      onlineCatalogue: { type: Boolean, default: false },
      unlimitedBusinessCategories: { type: Boolean, default: false },
      premiumCustomerSupport: { type: Boolean, default: false },
      trustStamp: { type: Boolean, default: false },
      verifiedBadge: { type: Boolean, default: false },
      whatsappConnect: { type: Boolean, default: false },
      leadAccess: { type: Boolean, default: false },
      enquiryNowBookNowButtons: { type: Boolean, default: false },
      googleMyBusinessIntegration: { type: Boolean, default: false },
      basicWebsite: { type: Boolean, default: false },
      aiSEO: { type: Boolean, default: false },
      smoo: { type: Boolean, default: false },
      monthlyPerformanceReport: { type: Boolean, default: false },
      ecommerceWebsite: { type: Boolean, default: false }
    },
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