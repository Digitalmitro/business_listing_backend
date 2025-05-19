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
} = require("../controllers/businessController");
const { authMiddleware } = require("../middlewares/authMiddleware");

const router = express.Router();

router.post(
  "/businesses",
  authMiddleware,
  upload.fields([{ name: "image", maxCount: 1 }]),
  createBusiness
);
router.get("/all-business", getAllBusiness);
router.put("/update-business", updateBusiness);
router.get("/businesses", getBusiness);
router.get("/user-business", authMiddleware, getuserBusiness);
router.get("/search", searchServices);
router.patch("/block/:businessId", blockBusiness);
router.delete("/delete/:businessId", deleteBusiness);
router.post("/check-phone", checkPhoneExists);
module.exports = router;
