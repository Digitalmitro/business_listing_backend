const express = require("express");
const router = express.Router();
const { upload } = require("../config/multerConfig");
const { authMiddleware } = require("../middlewares/authMiddleware");
const { requireAdmin } = require("../middlewares/requireAdmin");
const {
  getAllPopularSearches,
  createPopularSearch,
  updatePopularSearch,
  deletePopularSearch
} = require("../controllers/popularSearchController");

router.get("/", getAllPopularSearches);
router.post("/", authMiddleware, requireAdmin("cms"), upload.single("image"), createPopularSearch);
router.put("/:id", authMiddleware, requireAdmin("cms"), upload.single("image"), updatePopularSearch);
router.delete("/:id", authMiddleware, requireAdmin("cms"), deletePopularSearch);

module.exports = router;
