const mongoose = require("mongoose");
const dotenv = require("dotenv");
const path = require("path");
const Admin = require("../models/Admin");

dotenv.config({ path: path.join(__dirname, "../.env") });

const seedAdmins = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("MongoDB Connected...");

    const admins = await Admin.find({ name: { $exists: false } });
    console.log(`Found ${admins.length} admins without a name.`);

    for (const admin of admins) {
      admin.name = "Super Admin"; // Default name
      admin.role = "super-admin"; // Ensure existing admins are super-admins
      await admin.save();
      console.log(`Updated admin: ${admin.email}`);
    }

    console.log("All existing admins updated successfully.");
    process.exit(0);
  } catch (error) {
    console.error("Error seeding admins:", error);
    process.exit(1);
  }
};

seedAdmins();
