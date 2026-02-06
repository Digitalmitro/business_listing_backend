// routes/subCategoryRoutes.js — FINAL ORDER
const express = require("express");
const router = express.Router();
const { upload } = require("../config/multerConfig");
const {
  createSubCategory,
  getAllsubcategory, // ← Paginated admin list
  getSubCategories,
  deleteSubCategory,
  updateSubCategory,
  getSubCategoriesByCategoryIds,
  getPopularSearches,
  importSubCategoriesFromCSV,
  downloadSampleSubCategoryCSV,
  getAllSubcategoryPaginated,
  bulkRepairSubCategorySlugs,
} = require("../controllers/subCategoryContoller");

// STATIC ROUTES FIRST
router.get("/sample-subcategory-csv", downloadSampleSubCategoryCSV);
router.post(
  "/import-subcategory-csv",
  upload.single("csvFile"),
  importSubCategoriesFromCSV
);
// Existing routes
router.get("/repair-slugs", bulkRepairSubCategorySlugs);
router.post("/subcategories", upload.single("icon"), createSubCategory);
router.get("/subcategories", getAllsubcategory);
router.get("/subcategories-paginated", getAllSubcategoryPaginated);
router.get("/subcategories/:categoryId", getSubCategories);
router.post("/subcategories/by-categories", getSubCategoriesByCategoryIds);
router.delete("/:subCategoryId", deleteSubCategory);
router.put("/subcategories/:id", upload.single("icon"), updateSubCategory);
router.get("/popular-searches", getPopularSearches);

module.exports = router;
