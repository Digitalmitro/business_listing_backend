const SubCategory = require("../models/SubCategory");
const Category = require("../models/Category");
const { uploadToCloudinary } = require("../config/Cloudinary");
const csv = require("csv-parser");
const fs = require("fs");

exports.createSubCategory = async (req, res) => {
  try {
    const { name, description, category } = req.body;

    if (!name || !category || !req.file) {
      return res
        .status(400)
        .json({ message: "Name, category, and icon image are required" });
    }

    const existingCategory = await Category.findById(category);
    if (!existingCategory) {
      return res.status(404).json({ message: "Category not found" });
    }

    const iconUrl = `${req.protocol}://${req.get("host")}/uploads/${
      req.file.filename
    }`;

    let id = 1;

    const findLatestSubcategory = SubCategory.find({})
      .sort({ createdAt: -1 })
      .limit(1);
    if (findLatestSubcategory.id) {
      id = findLatestSubcategory.id;
    }

    const slug = name.toLowerCase().split(" ").join("-");
    const subCategory = new SubCategory({
      id,
      name,
      slug,
      category,
      description,
      iconUrl,
    });

    await subCategory.save();

    res
      .status(201)
      .json({ message: "SubCategory created successfully", subCategory });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error creating subcategory", error: error.message });
  }
};

exports.getSubCategories = async (req, res) => {
  try {
    const { categoryId } = req.params;
    if (!categoryId) {
      return res.status(400).json({ message: "Category ID is required" });
    }
    const subCategories = await SubCategory.find({ category: categoryId })
      .populate("category", "name iconUrl bgImage -_id") // Populate specific fields
      .select("-__v -createdAt -updatedAt");
    if (subCategories.length === 0) {
      return res
        .status(404)
        .json({ message: "No subcategories found for this category" });
    }
    const { category } = subCategories[0];
    return res.status(200).json({
      category,
      subCategories: subCategories.map((subCategory) => ({
        _id: subCategory._id,
        id: subCategory.id,
        name: subCategory.name,
        slug: subCategory.slug,
        iconUrl: subCategory.iconUrl,
      })),
    });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching subcategories", error: error.message });
  }
};

exports.getSubCategoriesByCategoryIds = async (req, res) => {
  try {
    let categoryIds = [];

    // Support both GET (query) and POST (body)
    if (req.method === "GET" && req.query.categoryIds) {
      categoryIds = req.query.categoryIds.split(",");
    } else if (req.body.categoryIds) {
      categoryIds = req.body.categoryIds;
    }

    if (!Array.isArray(categoryIds) || categoryIds.length === 0) {
      return res.status(400).json({ message: "Category IDs are required" });
    }

    // Fetch all matching subcategories
    const subCategories = await SubCategory.find({
      category: { $in: categoryIds },
    })
      .populate("category", "name iconUrl bgImage")
      .select("-__v -createdAt -updatedAt");

    if (!subCategories || subCategories.length === 0) {
      return res
        .status(404)
        .json({ message: "No subcategories found for given categories" });
    }

    // Optional: Group by category
    const grouped = {};
    subCategories.forEach((subCat) => {
      const catId = subCat.category._id.toString();
      if (!grouped[catId]) {
        grouped[catId] = {
          category: subCat.category,
          subCategories: [],
        };
      }
      grouped[catId].subCategories.push({
        _id: subCat._id,
        id: subCat.id,
        name: subCat.name,
        slug: subCat.slug,
        iconUrl: subCat.iconUrl,
      });
    });

    res.status(200).json({ data: grouped });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching subcategories", error: error.message });
  }
};

//this use for admin
exports.getAllsubcategory = async (req, res) => {
  try {
    const subCategories = await SubCategory.find().populate("category");

    return res.status(200).json(subCategories);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching subcategories", error: error.message });
  }
};

exports.getAllSubcategoryPaginated = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const total = await SubCategory.countDocuments();
    const subCategories = await SubCategory.find()
      .populate("category", "name")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    res.status(200).json({
      subCategories,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        total,
      },
    });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching subcategories", error: error.message });
  }
};

// delete api
exports.deleteSubCategory = async (req, res) => {
  try {
    const { subCategoryId } = req.params;

    // Check if subCategoryId is provided
    if (!subCategoryId) {
      return res.status(400).json({ message: "Subcategory ID is required" });
    }

    // Find and delete the subcategory
    const deletedSubCategory = await SubCategory.findByIdAndDelete(
      subCategoryId
    );

    // If subcategory is not found
    if (!deletedSubCategory) {
      return res.status(404).json({ message: "Subcategory not found" });
    }

    res.status(200).json({ message: "Subcategory deleted successfully" });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error deleting subcategory", error: error.message });
  }
};

// update api
exports.updateSubCategory = async (req, res) => {
  try {
    const { name, description, slug, category } = req.body;
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ message: "Subcategory ID is required" });
    }

    const subCategory = await SubCategory.findById(id);
    if (!subCategory) {
      return res.status(404).json({ message: "Subcategory not found" });
    }

    if (category) {
      const existingCategory = await Category.findById(category);
      if (!existingCategory) {
        return res.status(404).json({ message: "Category not found" });
      }
    }

    let iconUrl = subCategory.iconUrl;
    if (req.file) {
      iconUrl = `${req.protocol}://${req.get("host")}/uploads/${
        req.file.filename
      }`;
    }

    subCategory.name = name || subCategory.name;
    subCategory.category = category || subCategory.category;
    subCategory.description = description || subCategory.description;
    subCategory.slug = slug || subCategory.slug;
    subCategory.iconUrl = iconUrl;

    await subCategory.save();

    res
      .status(200)
      .json({ message: "Subcategory updated successfully", subCategory });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error updating subcategory", error: error.message });
  }
};

exports.getPopularSearches = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 30;
    const popular = await SubCategory.find()
      .sort({ searchCount: -1, name: 1 })
      .limit(limit)
      .select("name _id slug category");

    res.json({ success: true, popularSearches: popular });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.importSubCategoriesFromCSV = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "CSV file required" });
  }

  const filePath = req.file.path;
  const results = [];
  const errors = [];

  fs.createReadStream(filePath)
    .pipe(csv())
    .on("data", (data) => results.push(data))
    .on("end", async () => {
      try {
        // GET HIGHEST CURRENT ID
        const latestSubCat = await SubCategory.findOne()
          .sort({ id: -1 })
          .select("id");
        let nextId = latestSubCat && latestSubCat.id ? latestSubCat.id + 1 : 1;

        let created = 0;
        let skipped = 0;

        for (const row of results) {
          const name = row["name"]?.trim();
          const categoryName = row["category"]?.trim();
          const description = row["description"]?.trim() || "";

          if (!name || !categoryName) {
            errors.push(`Missing name or category: ${JSON.stringify(row)}`);
            skipped++;
            continue;
          }

          // Find parent category
          const category = await Category.findOne({
            name: { $regex: new RegExp(`^${categoryName}$`, "i") },
          });

          if (!category) {
            errors.push(`Category not found: ${categoryName}`);
            skipped++;
            continue;
          }

          // Check duplicate
          const exists = await SubCategory.findOne({
            name: { $regex: new RegExp(`^${name}$`, "i") },
            category: category._id,
          });

          if (exists) {
            errors.push(`Already exists: ${name} in ${categoryName}`);
            skipped++;
            continue;
          }

          const slug = name
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, "")
            .replace(/\s+/g, "-")
            .replace(/-+/g, "-")
            .trim();

          const subCat = new SubCategory({
            id: nextId++, // AUTO INCREMENT ID
            name,
            slug,
            category: category._id,
            description,
            iconUrl: "https://img.icons8.com/fluency/512/business.png", // default
          });

          await subCat.save();
          created++;
        }

        // Delete uploaded file
        fs.unlinkSync(filePath);

        res.json({
          success: true,
          message: "Subcategory import completed",
          created,
          skipped,
          totalImported: created,
          errors: errors.length > 0 ? errors : null,
        });
      } catch (err) {
        console.error("Import Error:", err);
        res.status(500).json({
          success: false,
          message: "Import failed",
          error: err.message,
        });
      }
    });
};

// SAMPLE CSV DOWNLOAD
exports.downloadSampleSubCategoryCSV = (req, res) => {
  const sample = [
    {
      name: "Residential Moving",
      category: "Packers and Movers",
      description: "Home relocation services",
    },
    {
      name: "AC Installation",
      category: "AC Repair",
      description: "New AC installation",
    },
    {
      name: "Bridal Makeup",
      category: "Beauty Salon",
      description: "Wedding makeup services",
    },
  ];

  const csv = [
    "name,category,description",
    ...sample.map((r) => `"${r.name}","${r.category}","${r.description}"`),
  ].join("\n");

  res.header("Content-Type", "text/csv");
  res.attachment("sample-subcategories.csv");
  res.send(csv);
};
