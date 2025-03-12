const express = require("express");
const router = express.Router();
const { upload } = require('../config/Cloudinary');


const {
  createSubCategory,
  getSubCategories,
  getAllsubcategory,
  deleteSubCategory,
  updateSubCategory
} = require("../controllers/subCategoryContoller"); // Adjust path

// Create a new SubCategory
router.post("/subcategories", upload.single("icon"), createSubCategory);

// Get all SubCategories or a specific SubCategory by ID
router.get("/subcategories/:categoryId", getSubCategories);
router.get("/subcategories", getAllsubcategory);
router.delete("/:subCategoryId", deleteSubCategory);
router.put('/subcategories/:id', upload.single('icon'), updateSubCategory);
module.exports = router;
