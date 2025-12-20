// fix-subcategory-ids.js
const mongoose = require("mongoose");
require("dotenv").config({
    path: require("path").resolve(__dirname, "../.env"),
  });
const SubCategory = require("../models/SubCategory"); // Adjust path as needed

const fixSubCategoryIds = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("Connected to MongoDB");

    // Fetch all subcategories sorted by createdAt (oldest first)
    const subCategories = await SubCategory.find({}).sort({ createdAt: 1 });

    if (subCategories.length === 0) {
      console.log("No subcategories found.");
      return process.exit(0);
    }

    console.log(`Found ${subCategories.length} subcategories. Fixing IDs...`);

    let nextId = 1;
    const bulkOps = [];

    for (const subCat of subCategories) {
      // Only update if id is missing or invalid
      if (!subCat.id || subCat.id < 1) {
        bulkOps.push({
          updateOne: {
            filter: { _id: subCat._id },
            update: { $set: { id: nextId } },
          },
        });
        console.log(`→ Assigning id: ${nextId} → ${subCat.name}`);
        nextId++;
      } else {
        // If current id is higher, use it as base for next
        if (subCat.id >= nextId) {
          nextId = subCat.id + 1;
        }
      }
    }

    if (bulkOps.length > 0) {
      const result = await SubCategory.bulkWrite(bulkOps);
      console.log(`\nSUCCESS: Fixed ${result.modifiedCount} subcategories!`);
    } else {
      console.log("\nAll subcategories already have valid IDs!");
    }

    console.log(`Next available ID: ${nextId}`);
    process.exit(0);
  } catch (error) {
    console.error("Error fixing subcategory IDs:", error);
    process.exit(1);
  }
};

fixSubCategoryIds();