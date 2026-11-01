const express = require("express");
const {
  createVertical,
  getAllVerticals,
  getVerticalByTitle,
  updateVertical,
  deleteVertical,
  insertManyVerticals
} = require("../controllers/verticalController");

const router = express.Router();
const { requireAdmin } = require("../middlewares/requireAdmin");

router.post("/", requireAdmin("cms"), createVertical); // Create a new vertical
router.get("/", getAllVerticals); // Get all verticals
router.get("/:title", getVerticalByTitle); // Get vertical by title
router.put("/:title", requireAdmin("cms"), updateVertical); // Update vertical by title
router.delete("/:title", requireAdmin("cms"), deleteVertical); // Delete vertical by title

module.exports = router;
