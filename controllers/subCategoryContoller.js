const SubCategory = require('../models/SubCategory');  // Adjust path
const Category = require('../models/Category');  // Adjust path to Category model

exports.createSubCategory = async (req, res) => {
  try {
    const { name, category } = req.body;
    if (!name || !category  || !req.file) {
      return res.status(400).json({ message: "Name and category are required" });
    }
    const existingCategory = await Category.findById(category);
    if (!existingCategory) {
      return res.status(404).json({ message: "Category not found" });
    }
    const iconUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
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
