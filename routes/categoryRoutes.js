// routes/categoryRoutes.js
const express = require("express");
const {
  createCategory,
  getAllCategories,
  getCategorywithTop,
  deleteCategory,
  getCategoryById,
  updateCategory,
  importCategoriesFromCSV,
  downloadSampleCategoryCSV,
  getAllCategoriesPaginated,
} = require("../controllers/categoryController");
const { upload } = require("../config/multerConfig");

const router = express.Router();

// ==================== STATIC ROUTES FIRST ====================
// These must come BEFORE any dynamic :id or :categoryId routes

router.get("/sample-csv", downloadSampleCategoryCSV); // ← Sample CSV download
router.post("/import-csv", upload.single("csvFile"), importCategoriesFromCSV); // ← Bulk import

router.get("/category-with-top", getCategorywithTop); // ← Get all + top categories
router.get("/categories", getAllCategories); // ← List all categories
router.get("/categories-paginated", getAllCategoriesPaginated);
// ==================== DYNAMIC ROUTES LAST ====================

router.post(
  "/categories",
  upload.fields([
    { name: "icon", maxCount: 1 },
    { name: "bgImage", maxCount: 1 },
  ]),
  createCategory
);

router.get("/:categoryId", getCategoryById); // ← Get single by ID
router.put(
  "/:categoryId",
  upload.fields([
    { name: "icon", maxCount: 1 },
    { name: "bgImage", maxCount: 1 },
  ]),
  updateCategory
);

router.delete("/:id", deleteCategory); // ← Delete by ID

module.exports = router;
