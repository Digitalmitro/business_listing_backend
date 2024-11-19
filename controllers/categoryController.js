const fs = require('fs');
const path = require('path');
const Category = require('../models/Category');

exports.createCategory = async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !req.file) {
      return res.status(400).json({ message: "Name and icon image are required" });
    }
    const iconUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
    const category = new Category({ name, iconUrl });
    await category.save();
    res.status(201).json({ message: "Category created successfully", category });
  } catch (error) {
    // Handle errors
    res.status(500).json({ message: "Error creating category", error: error.message });
  }
};

// Get all categories
exports.getAllCategories = async (req, res) => {
  try {
    const categories = await Category.find().sort({ createdAt: -1 });
    res.status(200).json({data:categories});
  } catch (error) {
    res.status(500).json({ message: "An error occurred while fetching categories" });
  }
};
