// routes/enquiryRoutes.js
const express = require("express");
const router = express.Router();
const {
  createEnquiry,
  getAllEnquiry,
  resolveEnquiry,
  deleteEnquiry,
} = require("../controllers/enquiryController");

router.post("/enquiry", createEnquiry);
router.get("/enquiry", getAllEnquiry);
router.put("/enquiry/:id", resolveEnquiry);     // Mark as resolved
router.delete("/enquiry/:id", deleteEnquiry);   // Delete enquiry

module.exports = router;