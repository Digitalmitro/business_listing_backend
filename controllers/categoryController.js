const fs = require("fs");
const path = require("path");
const Category = require("../models/Category");
const TopCat = require("../models/TopBannerCategory");
const { uploadToCloudinary ,cloudinary} = require("../config/Cloudinary");

exports.createCategory = async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name || !req.files.icon) {
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

    const iconUrl = await uploadToCloudinary(
      req.files.icon[0].buffer,
      "categoryIcon"
    );
    let bgImageUrl = null;
    if (req.files.bgImage) {
      bgImageUrl = await uploadToCloudinary(
        req.files.bgImage[0].buffer,
        "categoryBackgrounds"
      );
    }
    const slug = name.toLowerCase().split(' ').join('-')
    const category = new Category({ name, description, iconUrl,slug, bgImage: bgImageUrl });
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

    if (description) {
      category.description = description;
    }

    if(slug){
      category.slug = slug;
    }

    // Update icon if provided
    if (req.files && req.files.icon) {
      const iconUrl = await uploadToCloudinary(req.files.icon[0].buffer, "categoryIcon");
      category.iconUrl = iconUrl;
    }

    // Update background image if provided
    if (req.files && req.files.bgImage) {
      const bgImageUrl = await uploadToCloudinary(req.files.bgImage[0].buffer, "categoryBackgrounds");
      category.bgImage = bgImageUrl;
    }

    // Save the updated category
    await category.save();

    res.status(200).json({ message: "Category updated successfully", category });
  } catch (error) {
    console.log(error)
    res.status(500).json({ message: "Error updating category", error: error.message });
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
    res.status(500).json({ message: "Error fetching category", error: error.message });
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
