const fs = require("fs");
const path = require("path");
const Category = require("../models/Category");
const SubCategory = require("../models/SubCategory");
const TopCat = require("../models/TopBannerCategory");
const { uploadToCloudinary, cloudinary } = require("../config/Cloudinary");
const csv = require("csv-parser");

exports.createCategory = async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name || !req.files || !req.files.icon || !req.files.icon.length) {
      return res
        .status(400)
        .json({ message: "Name and icon image are required" });
    }

    // const iconUpload = req.files.icon[0];
    // const iconUrl = iconUpload.location;

    // let bgImageUrl = null;
    // if (req.files.bgImage) {
    //   const bgImageUpload = req.files.bgImage[0];
    //   bgImageUrl = bgImageUpload.location;
    // }

    const iconFile = req.files.icon[0];
    const iconUrl = `${req.protocol}://${req.get("host")}/uploads/${iconFile.filename}`;

    const slug = name.toLowerCase().split(" ").join("-");
    const category = new Category({
      name,
      description: description ? description : " ", // Use space if empty
      iconUrl,
      slug,
      // bgImage removed
    });
    await category.save();

    res
      .status(201)
      .json({ message: "Category created successfully", category });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error creating category", error: error.message });
  }
};

// update category
exports.updateCategory = async (req, res) => {
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

    // Update icon if provided
    if (req.files && req.files.icon) {
      const iconFile = req.files.icon[0];
      category.iconUrl = `${req.protocol}://${req.get("host")}/uploads/${iconFile.filename}`;
    }

    // bgImage update login removed

    // Save the updated category
    await category.save();

    res
      .status(200)
      .json({ message: "Category updated successfully", category });
  } catch (error) {
    console.log(error);
    res
      .status(500)
      .json({ message: "Error updating category", error: error.message });
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
      .select("_id name description slug iconUrl createdAt bgImage");
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
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select("_id name description slug iconUrl createdAt bgImage");

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

    // Function to extract public_id from a Cloudinary URL
    const getPublicIdFromUrl = (url) => {
      const parts = url.split("/");
      return parts[parts.length - 1].split(".")[0]; // Extract the file name without extension
    };

    // Delete icon from Cloudinary
    if (category.iconUrl) {
      const publicId = getPublicIdFromUrl(category.iconUrl);
      await cloudinary.uploader.destroy(publicId);
    }

    // Delete background image from Cloudinary if it exists
    if (category.bgImage) {
      const bgPublicId = getPublicIdFromUrl(category.bgImage);
      await cloudinary.uploader.destroy(bgPublicId);
    }

    // Now delete the category from the database
    await Category.findByIdAndDelete(id);
    res.status(200).json({ message: "Category deleted successfully" });
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

  fs.createReadStream(filePath)
    .pipe(csv())
    .on("data", (data) => results.push(data))
    .on("end", async () => {
      try {
        let created = 0;
        let skipped = 0;

        for (const row of results) {
          try {
            const name = row["name"]?.trim();
            const description = row["description"]?.trim() || "";

            if (!name) {
              errors.push(`Missing name: ${JSON.stringify(row)}`);
              skipped++;
              continue;
            }

            // Check if category already exists
            const exists = await Category.findOne({
              name: { $regex: new RegExp(`^${name}$`, "i") },
            });

            if (exists) {
              errors.push(`Already exists: ${name}`);
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
              // iconUrl uses default placeholder
              // bgImage optional
            });

            await category.save();
            created++;
          } catch (err) {
            errors.push(
              `Error processing ${row["name"] || "row"}: ${err.message}`
            );
            skipped++;
          }
        }

        // Clean up file
        fs.unlinkSync(filePath);

        res.json({
          message: "Category import completed",
          created,
          skipped,
          errors,
        });
      } catch (err) {
        console.error("CSV Import error:", err);
        res.status(500).json({ message: "Import failed" });
      }
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
      type: "category",
    }));

    const formattedSubCategories = subCategories.map((sub) => ({
      _id: sub._id,
      name: sub.name,
      slug: sub.slug,
      iconUrl: sub.iconUrl,
      type: "subcategory",
      parentCategory: sub.category?.name,
    }));

    res.status(200).json([...formattedCategories, ...formattedSubCategories]);
  } catch (error) {
    res.status(500).json({ message: "Search failed", error: error.message });
  }
};
