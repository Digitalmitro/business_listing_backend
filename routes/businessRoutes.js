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
} = require("../controllers/businessController");
const { getOffers, createOffer } = require("../controllers/offerController");
const { authMiddleware } = require("../middlewares/authMiddleware");

const router = express.Router();

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

router.post("/update-social-info/:businessId", authMiddleware, upload.single("video"), updateSocialInfo);
router.get('/profile-completion-score/:businessId', authMiddleware, calculateProfileCompletionScore);

router.put(
  "/update-contact-details/:id",
  authMiddleware,
  updateBusinessContactDetails
);
router.get("/get-offers/:id", authMiddleware, getOffers);
router.post("/create-offer", authMiddleware, createOffer);

router.get("/businesses", getBusiness);
router.get("/businessById/:id", getBusinessById);
router.get("/user-business", authMiddleware, getuserBusiness);
router.get("/search", searchServices);
router.patch("/block/:businessId", blockBusiness);
router.delete("/delete/:businessId", deleteBusiness);
router.post("/check-phone", checkPhoneExists);
module.exports = router;
