// scripts/seedPricing.js
require("dotenv").config({ path: require('path').resolve(__dirname, '../.env') });
const mongoose = require('mongoose');
const PricingPackage = require('../models/PricingPackage');

const packages = [
  {
    name: 'Silver',
    priceINR: 0,
    priceUSD: 0,
    priceGBP: 0,
    features: {
      searchVisibility: true,
      freeListing: true,
      reviewsAndRatings: true,
      businessDescription: true,
      businessHours: true,
      gallery: true,
      onlineCatalogue: false,
      unlimitedBusinessCategories: false,
      premiumCustomerSupport: false,
      trustStamp: false,
      verifiedBadge: false,
      whatsappConnect: false,
      leadAccess: false,
      enquiryNowBookNowButtons: false,
      googleMyBusinessIntegration: false,
      basicWebsite: false,
      aiSEO: false,
      smoo: false,
      monthlyPerformanceReport: false,
      ecommerceWebsite: false
    }
  },
  {
    name: 'Gold',
    priceINR: 2000,
    priceUSD: 100,
    priceGBP: 100,
    features: {
      searchVisibility: true,
      freeListing: true,
      reviewsAndRatings: true,
      businessDescription: true,
      businessHours: true,
      gallery: true,
      onlineCatalogue: true,
      unlimitedBusinessCategories: true,
      premiumCustomerSupport: true,
      trustStamp: true,
      verifiedBadge: true,
      whatsappConnect: true,
      leadAccess: false,
      enquiryNowBookNowButtons: false,
      googleMyBusinessIntegration: false,
      basicWebsite: false,
      aiSEO: false,
      smoo: false,
      monthlyPerformanceReport: false,
      ecommerceWebsite: false
    }
  },
  {
    name: 'Platinum',
    priceINR: 10000,
    priceUSD: 200,
    priceGBP: 200,
    features: {
      searchVisibility: true,
      freeListing: true,
      reviewsAndRatings: true,
      businessDescription: true,
      businessHours: true,
      gallery: true,
      onlineCatalogue: true,
      unlimitedBusinessCategories: true,
      premiumCustomerSupport: true,
      trustStamp: true,
      verifiedBadge: true,
      whatsappConnect: true,
      leadAccess: true,
      enquiryNowBookNowButtons: true,
      googleMyBusinessIntegration: true,
      basicWebsite: true,
      aiSEO: true,
      smoo: true,
      monthlyPerformanceReport: true,
      ecommerceWebsite: false
    }
  },
  {
    name: 'Diamond',
    priceINR: 15000,
    priceUSD: 300,
    priceGBP: 300,
    features: {
      searchVisibility: true,
      freeListing: true,
      reviewsAndRatings: true,
      businessDescription: true,
      businessHours: true,
      gallery: true,
      onlineCatalogue: true,
      unlimitedBusinessCategories: true,
      premiumCustomerSupport: true,
      trustStamp: true,
      verifiedBadge: true,
      whatsappConnect: true,
      leadAccess: true,
      enquiryNowBookNowButtons: true,
      googleMyBusinessIntegration: true,
      basicWebsite: true,
      aiSEO: true,
      smoo: true,
      monthlyPerformanceReport: true,
      ecommerceWebsite: true
    }
  }
];

mongoose.connect(process.env.MONGO_URI).then(async () => {
  await PricingPackage.deleteMany({});
  await PricingPackage.insertMany(packages);
  console.log('Pricing packages seeded!');
  process.exit();
});