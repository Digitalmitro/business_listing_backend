// routes/subCategoryRoutes.js — FINAL ORDER
const express = require("express");
const router = express.Router();
// `upload` stores CSV imports on disk; `memoryUpload` keeps icon images in memory for Cloudinary.
const { upload, memoryUpload } = require("../config/multerConfig");
const { requireAdmin } = require("../middlewares/requireAdmin");
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
  removeDuplicateSubCategories,
} = require("../controllers/subCategoryContoller");

// STATIC ROUTES FIRST
// Bulk maintenance writes: admin-only and never on GET (crawlers and prefetchers follow GETs).
router.post("/repair-slugs", requireAdmin("subcategories"), bulkRepairSubCategorySlugs);
router.post("/clean-duplicates", requireAdmin("subcategories"), removeDuplicateSubCategories);
router.get("/sample-subcategory-csv", downloadSampleSubCategoryCSV);
router.post(
  "/import-subcategory-csv",
  requireAdmin("subcategories"),
  upload.single("csvFile"),
  importSubCategoriesFromCSV
);
// Existing routes
router.post("/subcategories", requireAdmin("subcategories"), memoryUpload.single("icon"), createSubCategory);
router.get("/subcategories", getAllsubcategory);
router.get("/subcategories-paginated", getAllSubcategoryPaginated);
router.get("/subcategories/:categoryId", getSubCategories);
router.post("/subcategories/by-categories", getSubCategoriesByCategoryIds);
router.delete("/:subCategoryId", requireAdmin("subcategories"), deleteSubCategory);
router.put("/subcategories/:id", requireAdmin("subcategories"), memoryUpload.single("icon"), updateSubCategory);
router.get("/popular-searches", getPopularSearches);

module.exports = router;
