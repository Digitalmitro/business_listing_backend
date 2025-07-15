const express = require("express");
const {
  createCategory,
  getAllCategories,
  getCategorywithTop,
  deleteCategory,
  getCategoryById,
  updateCategory,
} = require("../controllers/categoryController");
const { upload } = require("../config/Cloudinary");
// const upload = require('../middlewares/uploadMiddleware')

const router = express.Router();

router.post(
  "/categories",
  upload.fields([
    { name: "icon", maxCount: 1 },
    { name: "bgImage", maxCount: 1 },
  ]),
  createCategory
);
router.get("/categories", getAllCategories);
router.get("/category-with-top", getCategorywithTop);
router.delete("/:id", deleteCategory);
router.get("/:categoryId", getCategoryById);
router.put(
  "/:categoryId",
  upload.fields([
    { name: "icon", maxCount: 1 },
    { name: "bgImage", maxCount: 1 },
  ]),
  updateCategory
);

module.exports = router;
