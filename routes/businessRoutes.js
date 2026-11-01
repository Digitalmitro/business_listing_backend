const express = require("express");
const { upload } = require("../config/multerConfig");
const {
  createBusiness,
  getBusiness,
  searchServices,
  blockBusiness,
  deleteBusiness,
  updateBusiness,
  getuserBusiness,
  getAllBusiness,
  checkPhoneExists,
  getBusinessById,
  updateKYC,
  deleteKYCDocument,
  updateBusinessContactDetails,
  updateSocialInfo,
  calculateProfileCompletionScore,
  updateBusinessStatus,
  downloadSampleCSV,
  downloadSampleExcel,
  searchBusinesses,
  getDistinctCountries,
} = require("../controllers/businessController");
const {
  getOffers,
  createOffer,
  deleteOffer,
} = require("../controllers/offerController");
const { authMiddleware, optionalAuth } = require("../middlewares/authMiddleware");
const { requireAdmin } = require("../middlewares/requireAdmin");
const {
  requireBusinessAccess,
  fromParam,
  fromBody,
  fromBusinessData,
} = require("../middlewares/businessAccess");
const { serveKycFile } = require("../controllers/kycFileController");
const { businessImportUpload } = require("../config/businessImportUpload");
const {
  importBusinesses,
  getBusinessImportBatch,
} = require("../controllers/businessImportController");

const router = express.Router();

router.get("/autocomplete", searchBusinesses);

router.post(
  "/businesses",
  authMiddleware,
  upload.fields([
    { name: "businessLogo", maxCount: 1 },
    { name: "photos", maxCount: 5 },
  ]),
  createBusiness
);
router.get("/distinct-countries", getDistinctCountries);
router.get("/all-business", getAllBusiness);

router.put(
  "/update-business",
  authMiddleware,
  upload.fields([
    { name: "businessLogo", maxCount: 1 },
    { name: "photos", maxCount: 5 },
  ]),
  requireBusinessAccess(fromBusinessData),
  updateBusiness
);

router.put(
  "/kyc-update",
  authMiddleware,
  upload.array("kycDocuments", 10), // Allow up to 10 documents
  requireBusinessAccess(fromBusinessData),
  updateKYC
);

router.delete("/kyc-delete-document/:id", authMiddleware, requireBusinessAccess(fromParam("id")), deleteKYCDocument);
// KYC files live outside the public /uploads directory; links are signed per owner/admin
// response (see services/kycFileService.js).
router.get("/kyc-file/:filename", serveKycFile);

router.patch(
  "/update-status/:id",
  authMiddleware,
  requireAdmin("business"),
  upload.single("video"),
  updateBusinessStatus
);
router.post(
  "/update-social-info/:businessId",
  authMiddleware,
  upload.single("video"),
  requireBusinessAccess(fromParam("businessId")),
  updateSocialInfo
);
router.get(
  "/profile-completion-score/:businessId",
  authMiddleware,
  requireBusinessAccess(fromParam("businessId")),
  calculateProfileCompletionScore
);

router.put(
  "/update-contact-details/:id",
  authMiddleware,
  requireBusinessAccess(fromParam("id")),
  updateBusinessContactDetails
);
router.get("/get-offers/:id", authMiddleware, getOffers);
router.post("/create-offer", authMiddleware, requireBusinessAccess(fromBody("businessId")), createOffer);
router.delete("/delete-offer/:offerId", authMiddleware, deleteOffer);

router.get("/businesses", getBusiness);
// Public, but the owner or an admin also gets the KYC documents (signed links).
router.get("/businessById/:id", optionalAuth, getBusinessById);
router.get("/user-business", authMiddleware, getuserBusiness);
router.get("/search", searchServices);
router.patch("/block/:businessId", authMiddleware, requireAdmin("business"), blockBusiness);
router.delete("/delete/:businessId", authMiddleware, requireAdmin("business"), deleteBusiness);
router.post("/check-phone", checkPhoneExists);

router.post(
  "/import-csv",
  authMiddleware,
  requireAdmin("business"),
  businessImportUpload,
  importBusinesses
);
router.post(
  "/import",
  authMiddleware,
  requireAdmin("business"),
  businessImportUpload,
  importBusinesses
);
router.get("/import-batches/:batchId", authMiddleware, requireAdmin("business"), getBusinessImportBatch);
router.get("/import-batches/:batchId/rows", authMiddleware, requireAdmin("business"), getBusinessImportBatch);

router.post("/sync-geocoding", authMiddleware, requireAdmin("business"), async (req, res) => {
  try {
    const Business = require("../models/Business");
    const { addJob } = require("../utils/queue");
    
    const pending = await Business.find({ 
      $or: [
        { "location.coordinates": [0, 0] },
        { needsGeocoding: true }
      ]
    });

    let queued = 0;
    for (const biz of pending) {
      await addJob("geocoding-batch", { businessId: biz._id });
      queued++;
    }

    res.json({ message: `Queued ${queued} businesses for geocoding`, counts: queued });
  } catch (err) {
    res.status(500).json({ message: "Sync failed", error: err.message });
  }
});

router.get("/download-sample-csv", downloadSampleCSV);
router.get("/download-sample-excel", downloadSampleExcel);

module.exports = router;
