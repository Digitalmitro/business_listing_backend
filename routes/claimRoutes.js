const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middlewares/authMiddleware");
const { upload } = require("../config/multerConfig");
const { requireAdmin } = require("../middlewares/requireAdmin");
const { submitClaim, getClaims, updateClaimStatus, getClaimById, syncApprovedClaims, getUserClaims } = require("../controllers/claimController");

router.get("/claims/my-claims", authMiddleware, getUserClaims);
router.post("/claims/:businessId", authMiddleware, upload.fields([{ name: "businessLogo" }, { name: "photos", maxCount: 5 }, { name: "kycDocuments" }]), submitClaim);
router.get("/claims", authMiddleware, requireAdmin("business"), getClaims);
router.put("/claims/:claimId/status", authMiddleware, requireAdmin("business"), updateClaimStatus);
router.get("/claims/:claimId", authMiddleware, requireAdmin("business"), getClaimById);
router.post("/sync-approved-claims", authMiddleware, requireAdmin("business"), syncApprovedClaims);

module.exports = router;