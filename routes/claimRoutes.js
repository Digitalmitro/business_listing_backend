const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middlewares/authMiddleware");
const { upload } = require("../config/multerConfig");
const { submitClaim, getClaims, updateClaimStatus, getClaimById, syncApprovedClaims, getUserClaims } = require("../controllers/claimController");

router.post("/claims/:businessId", authMiddleware, upload.fields([{ name: "businessLogo" }, { name: "photos", maxCount: 5 }, { name: "kycDocuments" }]), submitClaim);
router.get("/my-claims", authMiddleware, getUserClaims);
router.get("/claims", authMiddleware, getClaims);
router.put("/claims/:claimId/status", authMiddleware, updateClaimStatus);
router.get("/claims/:claimId", authMiddleware, getClaimById);
router.post("/sync-approved-claims", syncApprovedClaims);

module.exports = router;