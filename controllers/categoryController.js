const fs = require("fs");
const path = require("path");
const Category = require("../models/Category");
const SubCategory = require("../models/SubCategory");
const TopCat = require("../models/TopBannerCategory");
const images = require("../services/imageStorageService");
const csv = require("csv-parser");

// Image errors carry their own HTTP status (400 invalid image, 502 Cloudinary down) and a
// message that is safe to show to the admin; anything else is reported generically.
function respondError(res, error, fallbackMessage) {
  const status = Number.isInteger(error.status) && error.status >= 400 ? error.status : 500;
  if (status >= 500) console.error(error);
  const safeMessage = error.isOperational || status < 500 ? error.message : fallbackMessage;
  return res.status(status).json({ message: safeMessage, error: error.message });
}

function wantsIconRemoval(body) {
  return ["true", "1", "yes"].includes(String(body && body.removeIcon).toLowerCase());
}

exports.createCategory = async (req, res) => {
  let staged = null;
  try {
    const { name, description } = req.body;
    const iconFile = req.files && req.files.icon && req.files.icon[0];
    if (!name || !iconFile) {
      return res
        .status(400)
        .json({ message: "Name and icon image are required" });
    }

    const slug = name.toLowerCase().split(" ").join("-");
    const category = new Category({
      name,
      description: description ? description : " ", // Use space if empty
      slug,
      // bgImage removed
    });

    // Validate the bytes and upload to Cloudinary FIRST; the record is created only
    // once the asset exists, so a failed upload never leaves a broken record.
    staged = await images.stageImageUpload(category, iconFile, { kind: "category" });

    try {
      await category.save();
    } catch (saveError) {
      // Nothing was written: drop the asset we just uploaded unless another record uses it.
      await images.discardStagedUpload(staged);
      throw saveError;
    }

    res
      .status(201)
      .json({ message: "Category created successfully", category });
  } catch (error) {
    respondError(res, error, "Error creating category");
  }
};

// update category
exports.updateCategory = async (req, res) => {
  let staged = null;
  try {
    const { categoryId } = req.params;
    const { name, description, slug } = req.body;

    // Find existing category
    const category = await Category.findById(categoryId);
    if (!category) {
      return res.status(404).json({ message: "Category not found" });
    }

    // Update name if provided
    if (name) {
      category.name = name;
    }

    // Update description if provided, or if explicitly sent as empty string (though UI removes it)
    if (description !== undefined) {
      category.description = description || " ";
    }

    if (slug) {
      category.slug = slug;
    }

    // Icon change: upload the NEW image first, save, verify the saved record, and only
    // then release the OLD asset (and only if no other record still references it).
    // A failed upload therefore leaves the existing icon untouched.
    const iconFile = req.files && req.files.icon && req.files.icon[0];
    if (iconFile) {
      staged = await images.stageImageUpload(category, iconFile, { kind: "category" });
    } else if (wantsIconRemoval(req.body)) {
      staged = images.stageImageRemoval(category);
    }

    // bgImage update login removed

    try {
      await category.save();
    } catch (saveError) {
      // The old asset is untouched; make sure the new one is not left orphaned.
      await images.discardStagedUpload(staged);
      throw saveError;
    }

    const imageChange = staged ? await images.finishImageChange(category, staged) : undefined;

    res
      .status(200)
      .json({ message: "Category updated successfully", category, ...(imageChange ? { imageChange } : {}) });
  } catch (error) {
    respondError(res, error, "Error updating category");
  }
};

// get category by id
exports.getCategoryById = async (req, res) => {
  try {
    const { categoryId } = req.params;
    const category = await Category.findById(categoryId);

    if (!category) {
      return res.status(404).json({ message: "Category not found" });
    }

    res.status(200).json(category);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching category", error: error.message });
  }
};

// Get all categories
exports.getAllCategories = async (req, res) => {
  try {
    const categories = await Category.find()
      .sort({ createdAt: 1 })
      .select("_id name description slug iconUrl icon createdAt bgImage");
    res.status(200).json(categories);
  } catch (error) {
    res
      .status(500)
      .json({ message: "An error occurred while fetching categories" });
  }
};

exports.getAllCategoriesPaginated = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || "";
    const skip = (page - 1) * limit;

    const query = {};
    if (search) {
      query.name = { $regex: search, $options: "i" };
    }

    const total = await Category.countDocuments(query);
    const categories = await Category.find(query)
      .sort({ createdAt: -1, _id: 1 })
      .skip(skip)
      .limit(limit)
      .select("_id name description slug iconUrl icon createdAt bgImage");

    res.status(200).json({
      categories,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        total,
        hasNext: page < Math.ceil(total / limit),
        hasPrev: page > 1,
      },
    });
  } catch (error) {
    console.error("Error fetching categories:", error);
    res
      .status(500)
      .json({ message: "An error occurred while fetching categories" });
  }
};

//get all category and top category
exports.getCategorywithTop = async (req, res) => {
  try {
    const category = await Category.find();
    const topCategory = await TopCat.find();

    res.status(200).json({ category, topCategory: [...topCategory] });
  } catch (error) {
    res
      .status(500)
      .json({ message: "An error occurred while fetching categories" });
  }
};

exports.deleteCategory = async (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(200).json({ message: "missing id" });

  try {
    const category = await Category.findById(id);
    if (!category) {
      return res.status(404).json({ message: "Category not found" });
    }

    // DB first, so the API never points at a deleted asset. The Cloudinary asset is
    // removed afterwards, and only when no other record references it. Legacy
    // /uploads files and the default placeholder are never touched.
    await Category.findByIdAndDelete(id);
    const imageRelease = await images.releaseDocumentImage(category);

    res.status(200).json({ message: "Category deleted successfully", imageRelease });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};

exports.importCategoriesFromCSV = async (req, res) => {
  if (!req.file) return res.status(400).json({ message: "CSV file required" });

  const filePath = req.file.path;
  const results = [];
  const errors = [];

  console.log(`[CategoryImport] Starting import: file=${req.file.originalname}, size=${req.file.size}`);

  fs.createReadStream(filePath)
    .pipe(csv())
    .on("data", (data) => results.push(data))
    .on("end", async () => {
      try {
        let created = 0;
        let skipped = 0;

        // Log the headers found in the file so mismatches are obvious
        if (results.length > 0) {
          console.log(`[CategoryImport] CSV headers detected:`, Object.keys(results[0]));
          console.log(`[CategoryImport] Total rows to process: ${results.length}`);
        }

        for (const row of results) {
          try {
            // Accept multiple common header variants for the category name
            const name = (
              row["name"] || row["Name"] ||
              row["category_name"] || row["Category Name"] ||
              row["category"] || row["Category"] ||
              row["title"] || row["Title"] || ""
            ).toString().trim();

            const description = (
              row["description"] || row["Description"] || ""
            ).toString().trim();

            if (!name) {
              const msg = `Skipped row — no name found. Headers in file: ${Object.keys(row).join(", ")}`;
              errors.push(msg);
              console.warn(`[CategoryImport] ${msg}`);
              skipped++;
              continue;
            }

            // Check if category already exists
            const exists = await Category.findOne({
              name: { $regex: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") },
            });

            if (exists) {
              const msg = `Already exists: ${name}`;
              errors.push(msg);
              console.log(`[CategoryImport] ${msg}`);
              skipped++;
              continue;
            }

            const slug = name
              .toLowerCase()
              .trim()
              .replace(/[^a-z0-9\s-]/g, "")
              .replace(/\s+/g, "-")
              .replace(/-+/g, "-");

            const category = new Category({
              name,
              slug,
              description,
            });

            await category.save();
            console.log(`[CategoryImport] Created: ${name}`);
            created++;
          } catch (err) {
            const msg = `Error processing "${row["name"] || row["category"] || "row"}": ${err.message}`;
            errors.push(msg);
            console.error(`[CategoryImport] ${msg}`);
            skipped++;
          }
        }

        // Clean up file
        try { fs.unlinkSync(filePath); } catch (_) {}

        console.log(`[CategoryImport] Done — created:${created} skipped:${skipped} errors:${errors.length}`);

        res.json({
          message: "Category import completed",
          created,
          skipped,
          errors: errors.length > 20 ? errors.slice(0, 20).concat([`... and ${errors.length - 20} more`]) : errors,
        });
      } catch (err) {
        console.error("[CategoryImport] Fatal error:", err);
        try { fs.unlinkSync(filePath); } catch (_) {}
        res.status(500).json({ message: "Import failed", error: err.message });
      }
    })
    .on("error", (err) => {
      console.error("[CategoryImport] Stream error:", err);
      try { fs.unlinkSync(filePath); } catch (_) {}
      res.status(500).json({ message: "Failed to read CSV file", error: err.message });
    });
};

exports.downloadSampleCategoryCSV = (req, res) => {
  const sampleData = [
    { name: "Plumbers", description: "Professional plumbing services" },
    { name: "Electricians", description: "Electrical repair and installation" },
    { name: "Beauty Salon", description: "Hair, makeup, and spa services" },
    { name: "AC Repair", description: "Air conditioning maintenance" },
    { name: "Packers and Movers", description: "Home and office relocation" },
  ];

  const csvContent = [
    "name,description",
    ...sampleData.map((row) => `"${row.name}","${row.description}"`),
  ].join("\n");

  res.header("Content-Type", "text/csv");
  res.attachment("sample-categories.csv");
  res.send(csvContent);
};

exports.searchCategories = async (req, res) => {
  try {
    const { query } = req.query;
    if (!query) {
      return res.status(200).json([]);
    }

    const categories = await Category.find({
      name: { $regex: query, $options: "i" },
    }).limit(5);

    const subCategories = await SubCategory.find({
      name: { $regex: query, $options: "i" },
    })
      .populate("category", "name")
      .limit(10);

    const formattedCategories = categories.map((cat) => ({
      _id: cat._id,
      name: cat.name,
      slug: cat.slug,
      iconUrl: cat.iconUrl,
      icon: cat.icon,
      type: "category",
    }));

    const formattedSubCategories = subCategories.map((sub) => ({
      _id: sub._id,
      name: sub.name,
      slug: sub.slug,
      iconUrl: sub.iconUrl,
      icon: sub.icon,
      type: "subcategory",
      parentCategory: sub.category?.name,
    }));

    res.status(200).json([...formattedCategories, ...formattedSubCategories]);
  } catch (error) {
    res.status(500).json({ message: "Search failed", error: error.message });
  }
};
