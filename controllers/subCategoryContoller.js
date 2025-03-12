const SubCategory = require('../models/SubCategory');  
const Category = require('../models/Category');  
const { uploadToCloudinary } = require("../config/Cloudinary");

exports.createSubCategory = async (req, res) => {
  try {
    const { name, category } = req.body;

    if (!name || !category || !req.file) {
      return res.status(400).json({ message: "Name, category, and icon image are required" });
    }

    const existingCategory = await Category.findById(category);
    if (!existingCategory) {
      return res.status(404).json({ message: "Category not found" });
    }

    const iconUrl = await uploadToCloudinary(req.file.buffer, "subCategoryIcons");

    const subCategory = new SubCategory({
      name,
      category,
      iconUrl
    });

    await subCategory.save();

    res.status(201).json({ message: "SubCategory created successfully", subCategory });

  } catch (error) {
    res.status(500).json({ message: "Error creating subcategory", error: error.message });
  }
};


exports.getSubCategories = async (req, res) => {
    try {
      const { categoryId } = req.params;
    if (!categoryId) {
        return res.status(400).json({ message: "Category ID is required" });
      }
      const subCategories = await SubCategory.find({ category: categoryId })
        .populate('category', 'name iconUrl bgImage -_id') // Populate specific fields
        .select("-__v -createdAt -updatedAt");
      if (subCategories.length === 0) {
        return res.status(404).json({ message: "No subcategories found for this category" });
      }
      const { category } = subCategories[0];
      return res.status(200).json({
        category,
        subCategories: subCategories.map(subCategory => ({
          _id: subCategory._id,
          name: subCategory.name,
          iconUrl:subCategory.iconUrl
        }))
      });
    } catch (error) {
      res.status(500).json({ message: "Error fetching subcategories", error: error.message });
    }
};
//this use for admin
exports.getAllsubcategory = async (req,res) =>{
  try {
    const subCategories = await SubCategory.find().populate('category')

    return res.status(200).json(subCategories)
  } catch (error) {
    res.status(500).json({ message: "Error fetching subcategories", error: error.message });
  }
}

// delete api
exports.deleteSubCategory = async (req, res) => {
  try {
      const { subCategoryId } = req.params;

      // Check if subCategoryId is provided
      if (!subCategoryId) {
          return res.status(400).json({ message: "Subcategory ID is required" });
      }

      // Find and delete the subcategory
      const deletedSubCategory = await SubCategory.findByIdAndDelete(subCategoryId);

      // If subcategory is not found
      if (!deletedSubCategory) {
          return res.status(404).json({ message: "Subcategory not found" });
      }

      res.status(200).json({ message: "Subcategory deleted successfully" });
  } catch (error) {
      res.status(500).json({ message: "Error deleting subcategory", error: error.message });
  }
};


// update api
exports.updateSubCategory = async (req, res) => {
  try {
    const { name, category } = req.body;
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
      iconUrl = await uploadToCloudinary(req.file.buffer, "subCategoryIcons");
    }

    subCategory.name = name || subCategory.name;
    subCategory.category = category || subCategory.category;
    subCategory.iconUrl = iconUrl;

    await subCategory.save();

    res.status(200).json({ message: "Subcategory updated successfully", subCategory });
  } catch (error) {
    res.status(500).json({ message: "Error updating subcategory", error: error.message });
  }
};


