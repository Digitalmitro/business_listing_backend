// Seeds the pricing packages (Basic / Silver / Gold / Premium) on an EMPTY or test DB.
// It replaces every package. On a database with paying businesses use
// scripts/migratePricingPlans.js instead, which also maps existing subscriptions.
require("dotenv").config({ path: require('path').resolve(__dirname, '../.env') });
const mongoose = require('mongoose');
const PricingPackage = require('../models/PricingPackage');
const { buildPackages } = require('./pricingPlans.data');

mongoose.connect(process.env.MONGO_URI).then(async () => {
  await PricingPackage.deleteMany({});
  await PricingPackage.insertMany(buildPackages());
  console.log('Pricing packages seeded!');
  process.exit();
});
