// scripts/seedTopBannerCategories.js
const mongoose = require("mongoose");
require("dotenv").config({ path: require('path').resolve(__dirname, '../.env') });

const TopBannerCategory = require("../models/TopBannerCategory");
const Category = require("../models/Category"); // ← Tera Category model

// CONNECT TO DB
mongoose
  .connect(process.env.MONGO_URI || "mongodb://localhost:27017/urbancitations", {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("MongoDB Connected for Seeding"))
  .catch((err) => {
    console.error("Connection failed:", err);
    process.exit(1);
  });

// SEED DATA — Title = Category Name (Exact Match)
const seedData = [
  {
    title: "Plumber",
    paragraph: "24/7 Emergency Plumbing Services Near You",
    bgColor: "#0076D7",
    priority: 10,
  },
  {
    title: "Electrician",
    paragraph: "Fast & Safe Electrical Repairs",
    bgColor: "#FFB800",
    priority: 9,
  },
  {
    title: "Carpenter",
    paragraph: "Custom Furniture & Woodwork",
    bgColor: "#28A745",
    priority: 8,
  },
  {
    title: "AC Repair",
    paragraph: "Quick AC Service & Installation",
    bgColor: "#DC3545",
    priority: 10,
  },
  {
    title: "Pest Control",
    paragraph: "100% Safe & Effective Solutions",
    bgColor: "#6F42C1",
    priority: 7,
  },
  {
    title: "Salon & Spa",
    paragraph: "Premium Beauty & Wellness Services",
    bgColor: "#E83E8C",
    priority: 10,
  },
  {
    title: "Home Cleaning",
    paragraph: "Deep Cleaning by Verified Professionals",
    bgColor: "#17A2B8",
    priority: 9,
  },
  {
    title: "Painter",
    paragraph: "Interior & Exterior Painting Experts",
    bgColor: "#FD7E14",
    priority: 8,
  },
];

// MAIN SEED FUNCTION
const seed = async () => {
  try {
    console.log("Starting TopBannerCategory seeding...");

    // Optional: Clear existing (uncomment if needed)
    // await TopBannerCategory.deleteMany({});
    // console.log("Cleared existing TopBannerCategory");

    let createdCount = 0;

    for (const item of seedData) {
      const { title } = item;

      // Skip if already exists
      const exists = await TopBannerCategory.findOne({
        title: { $regex: `^${title}$`, $options: "i" },
      });
      if (exists) {
        console.log(`Skipping (already exists): ${title}`);
        continue;
      }

      // Find matching category
      const category = await Category.findOne({
        name: { $regex: `^${title}$`, $options: "i" },
      });

      if (!category) {
        console.log(`Category not found for: ${title} → Skipping`);
        continue;
      }

      // Create TopBanner
      const newBanner = new TopBannerCategory({
        title: title.trim(),
        paragraph: item.paragraph,
        imageUrl: `https://via.placeholder.com/400x300/333/fff?text=${encodeURIComponent(title)}`, // ← Placeholder
        bgColor: item.bgColor,
        priority: item.priority,
        categoryId: category._id,
        isActive: true,
      });

      await newBanner.save();
      createdCount++;
      console.log(`Created: ${title} → Linked to ${category.name}`);
    }

    console.log(`SEEDING COMPLETE! ${createdCount} Top Banners Created`);
    process.exit(0);
  } catch (error) {
    console.error("Seeding failed:", error);
    process.exit(1);
  }
};

seed();