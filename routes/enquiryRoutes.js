// routes/enquiryRoutes.js
const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middlewares/authMiddleware");
const { requireAdmin } = require("../middlewares/requireAdmin");
const { requireBusinessAccess, fromParam } = require("../middlewares/businessAccess");
const {
  createEnquiry,
  getAllEnquiry,
  resolveEnquiry,
  deleteEnquiry,
  getEnquiriesByBusinessId, // ← NEW ROUTE
} = require("../controllers/enquiryController");

// Public routes
router.post("/enquiry", createEnquiry);
router.get("/enquiry", authMiddleware, requireAdmin("enquiries"), getAllEnquiry); // Admin
router.put("/enquiry/:id", authMiddleware, requireAdmin("enquiries"), resolveEnquiry); // Admin
router.delete("/enquiry/:id", authMiddleware, requireAdmin("enquiries"), deleteEnquiry); // Admin

// Enquiries for one business: its owner or an admin (they contain customers' phone numbers)
router.get(
  "/enquiry/business/:businessId",
  authMiddleware,
  requireBusinessAccess(fromParam("businessId")),
  getEnquiriesByBusinessId
);

module.exports = router;
