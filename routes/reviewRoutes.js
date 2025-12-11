const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middlewares/authMiddleware.js");
const {
  createReview,
  getReviews,
  getAllBusinessReviews,
} = require("../controllers/reviewController.js");

router.post("/reviews", authMiddleware, createReview);
router.get("/reviews/:businessId", getReviews);
router.post("/all-business-reviews", getAllBusinessReviews);

module.exports = router;
