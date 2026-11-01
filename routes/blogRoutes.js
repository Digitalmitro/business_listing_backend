// routes/blogRoutes.js
const express = require("express");
const router = express.Router();
const {
  createBlog,
  getBlogs,
  getBlogBySlug,
  updateBlog,
  deleteBlog,
} = require("../controllers/blogController");
const { authMiddleware } = require("../middlewares/authMiddleware");
const { requireAdmin } = require("../middlewares/requireAdmin");
const { upload } = require("../config/multerConfig");

// Public
router.get("/", getBlogs); // /api/blog
router.get("/:slug", getBlogBySlug); // /api/blog/what-heatmaps-reveal...

// Admin
router.post("/", authMiddleware, requireAdmin("cms"), upload.single("featuredImage"), createBlog);
router.put("/:id", authMiddleware, requireAdmin("cms"), upload.single("featuredImage"), updateBlog);
router.delete("/:id", authMiddleware, requireAdmin("cms"), deleteBlog);

module.exports = router;
