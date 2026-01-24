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
  importBusinessFromCSV,
  downloadSampleCSV,
  searchBusinesses,
} = require("../controllers/businessController");
const {
  getOffers,
  createOffer,
  deleteOffer,
} = require("../controllers/offerController");
const { authMiddleware } = require("../middlewares/authMiddleware");

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
router.get("/all-business", getAllBusiness);

router.put(
  "/update-business",
  authMiddleware,
  upload.fields([
    { name: "businessLogo", maxCount: 1 },
    { name: "photos", maxCount: 5 },
  ]),
  updateBusiness
);

router.put(
  "/kyc-update",
  authMiddleware,
  upload.array("kycDocuments", 10), // Allow up to 10 documents
  updateKYC
);

router.delete("/kyc-delete-document/:id", authMiddleware, deleteKYCDocument);

router.patch(
  "/update-status/:id",
  authMiddleware,
  upload.single("video"),
  updateBusinessStatus
);
router.post(
  "/update-social-info/:businessId",
  authMiddleware,
  upload.single("video"),
  updateSocialInfo
);
router.get(
  "/profile-completion-score/:businessId",
  authMiddleware,
  calculateProfileCompletionScore
);

router.put(
  "/update-contact-details/:id",
  authMiddleware,
  updateBusinessContactDetails
);
router.get("/get-offers/:id", authMiddleware, getOffers);
router.post("/create-offer", authMiddleware, createOffer);
router.delete("/delete-offer/:offerId", authMiddleware, deleteOffer);

router.get("/businesses", getBusiness);
router.get("/businessById/:id", getBusinessById);
router.get("/user-business", authMiddleware, getuserBusiness);
router.get("/search", searchServices);
router.patch("/block/:businessId", blockBusiness);
router.delete("/delete/:businessId", deleteBusiness);
router.post("/check-phone", checkPhoneExists);

router.post(
  "/import-csv",
  authMiddleware,
  upload.single("csvFile"),
  importBusinessFromCSV
);

router.post("/sync-geocoding", authMiddleware, async (req, res) => {
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

module.exports = router;
