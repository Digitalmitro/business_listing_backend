const fs = require('fs');
const path = require('path');
const Category = require('../models/Category');
const TopCat = require('../models/TopBannerCategory')

exports.createCategory = async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !req.files.icon) {
      return res.status(400).json({ message: "Name and icon image are required" });
    }

    const iconUpload = req.files.icon[0];
    const iconUrl = iconUpload.location;

    let bgImageUrl = null;
    if (req.files.bgImage) {
      const bgImageUpload = req.files.bgImage[0];
      bgImageUrl = bgImageUpload.location;
    }

    const category = new Category({ name, iconUrl, bgImage: bgImageUrl });
    await category.save();
    
    res.status(201).json({ message: "Category created successfully", category });
  } catch (error) {
    res.status(500).json({ message: "Error creating category", error: error.message });
  }
};

// Get all categories
exports.getAllCategories = async (req, res) => {
  try {
    const categories = await Category.find().sort({ createdAt: 1 }).select("_id name  iconUrl createdAt");
    res.status(200).json(categories);
  } catch (error) {
    res.status(500).json({ message: "An error occurred while fetching categories" });
  }
};


//get all category and top category
exports.getCategorywithTop = async (req,res) =>{
  try {
    const category = await Category.find()
    const topCategory = await TopCat.find()

    res.status(200).json({category, topCategory:[...topCategory]})
  } catch (error) {
    res.status(500).json({ message: "An error occurred while fetching categories" });
  }  

}


exports.deleteCategory = async (req,res) =>{
  const { id } = req.params; 
if(!id) return res.status(200).json({ message:'missing id'})
  try {
    const category = await Category.findByIdAndDelete(id); 
    if (!category) {
      return res.status(404).json({ message: 'Category not found' });
    }

    res.status(200).json({ message: 'Category deleted successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
}