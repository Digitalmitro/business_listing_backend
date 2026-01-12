const express = require("express");
const router = express.Router();
const { upload } = require("../config/multerConfig");
const { authMiddleware } = require("../middlewares/authMiddleware");
const {
  getAllPopularSearches,
  createPopularSearch,
  updatePopularSearch,
  deletePopularSearch
} = require("../controllers/popularSearchController");

router.get("/", getAllPopularSearches);
router.post("/", authMiddleware, upload.single("image"), createPopularSearch);
router.put("/:id", authMiddleware, upload.single("image"), updatePopularSearch);
router.delete("/:id", authMiddleware, deletePopularSearch);

module.exports = router;
