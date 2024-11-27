const express = require('express');
const router = express.Router();
const {upload }= require('../config/multerConfig')
const { createSubCategory, getSubCategories, getAllsubcategory } = require('../controllers/subCategoryContoller'); // Adjust path

// Create a new SubCategory
router.post('/subcategories',upload.single('icon'), createSubCategory);

// Get all SubCategories or a specific SubCategory by ID
router.get('/subcategories/:categoryId', getSubCategories);
router.get('/subcategories', getAllsubcategory)

module.exports = router;
