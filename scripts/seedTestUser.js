const mongoose = require("mongoose");
const dotenv = require("dotenv");
const path = require("path");
const User = require("../models/User");
const Tenant = require("../models/Tenant");

dotenv.config({ path: path.join(__dirname, "../.env") });

// Mirrors authController.register (User -> Tenant -> link) without the email queue.
const TEST_USER = {
  full_name: "Test Account",
  email: "bijacas622@bowlfuel.com",
  password: "y82yc4AXb7L8w3K",
  isAgree: true,
  subscribedToEmails: true,
  timeZone: "Asia/Kolkata",
  country: "India",
};

const seedTestUser = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("MongoDB Connected...");

    let user = await User.findOne({ email: TEST_USER.email });
    if (user) {
      console.log(`User already exists: ${user.email} (${user._id})`);
    } else {
      user = await User.create(TEST_USER);
      console.log(`Created user: ${user.email} (${user._id})`);
    }

    if (!user.tenantId) {
      const tenant = await Tenant.create({ ownerUserId: user._id, name: user.full_name });
      user.tenantId = tenant._id;
      await user.save();
      console.log(`Created tenant: ${tenant._id}`);
    } else {
      console.log(`Tenant already linked: ${user.tenantId}`);
    }

    console.log("Test user seeded successfully.");
    process.exit(0);
  } catch (error) {
    console.error("Error seeding test user:", error);
    process.exit(1);
  }
};

seedTestUser();
