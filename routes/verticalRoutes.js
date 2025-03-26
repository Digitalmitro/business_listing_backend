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

router.post("/", createVertical); // Create a new vertical
router.get("/", getAllVerticals); // Get all verticals
router.get("/:title", getVerticalByTitle); // Get vertical by title
router.put("/:title", updateVertical); // Update vertical by title
router.delete("/:title", deleteVertical); // Delete vertical by title

module.exports = router;
