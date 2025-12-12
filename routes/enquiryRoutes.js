// routes/enquiryRoutes.js
const express = require("express");
const router = express.Router();
const {
  createEnquiry,
  getAllEnquiry,
  resolveEnquiry,
  deleteEnquiry,
  getEnquiriesByBusinessId, // ← NEW ROUTE
} = require("../controllers/enquiryController");

// Public routes
router.post("/enquiry", createEnquiry);
router.get("/enquiry", getAllEnquiry); // Admin
router.put("/enquiry/:id", resolveEnquiry); // Admin
router.delete("/enquiry/:id", deleteEnquiry); // Admin

// NEW: Get enquiries for a specific business (Owner login required)
router.get("/enquiry/business/:businessId", getEnquiriesByBusinessId);

module.exports = router;
