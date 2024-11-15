const fs = require('fs');
const path = require('path');
const Category = require('../models/Category');


// Create a new category with an icon upload
exports.createCategory = async (req, res) => {
//   try {
//     const { name } = req.body;

//     // Validate required fields
//     if (!name || !req.file) {
//       return res.status(400).json({ message: "Please provide both category name and icon" });
//     }

//     // Upload image to Cloudinary
//     const result = await cloudinary.uploader.upload(req.file.path, {
//       folder: 'category-icons',
//       transformation: [{ width: 200, height: 200, crop: 'limit' }]  // Optimize image size
//     });

//     // Delete the local file after uploading to Cloudinary
//     fs.unlinkSync(req.file.path);

//     // Save category with the Cloudinary URL of the icon
//     const category = new Category({ name, iconUrl: result.secure_url });
//     await category.save();

//     res.status(201).json({ message: "Category created successfully", category });
//   } catch (error) {
//     // Handle duplicate category name error
//     if (error.code === 11000) {
//       return res.status(400).json({ message: "Category name already exists" });
//     }

//     // General error handling
//     res.status(500).json({ message: "An error occurred while creating the category", error: error.message });
//   }
// Dummy categories data
const categories = [
    { name: 'Technology', iconUrl: 'https://res.cloudinary.com/your-cloud-name/image/upload/v1234567890/tech_icon.png' },
    { name: 'Health & Fitness', iconUrl: 'https://res.cloudinary.com/your-cloud-name/image/upload/v1234567890/health_icon.png' },
    { name: 'Food & Beverages', iconUrl: 'https://res.cloudinary.com/your-cloud-name/image/upload/v1234567890/food_icon.png' },
    { name: 'Fashion', iconUrl: 'https://res.cloudinary.com/your-cloud-name/image/upload/v1234567890/fashion_icon.png' },
    { name: 'Entertainment', iconUrl: 'https://res.cloudinary.com/your-cloud-name/image/upload/v1234567890/entertainment_icon.png' }
  ];

  // Insert categories into the database
  try {
    await Category.insertMany(categories);
    console.log('Dummy categories inserted successfully!');
    res.status(201).json({mssage:"category added sucessfull"})
  } catch (error) {
    console.log('Error inserting categories:', error);
  }

};

// Get all categories
exports.getAllCategories = async (req, res) => {
  try {
    const categories = await Category.find().sort({ createdAt: -1 });
    res.status(200).json(categories);
  } catch (error) {
    res.status(500).json({ message: "An error occurred while fetching categories" });
  }
};
