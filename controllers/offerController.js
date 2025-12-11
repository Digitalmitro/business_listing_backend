const Offer = require("../models/Offer");
const mongoose = require("mongoose");
const Business = require("../models/Business");

exports.createOffer = async (req, res) => {
  const {
    businessId,
    couponCode,
    discountRate,
    expirationDate,
    categoryId,
    subCategoryId,
  } = req.body;

  if (
    !businessId ||
    !couponCode ||
    !discountRate ||
    !expirationDate ||
    !categoryId
  ) {
    return res.status(400).json({
      success: false,
      message:
        "Missing required fields (businessId, couponCode, discountRate, expirationDate, categoryId)",
    });
  }

  if (discountRate < 0 || discountRate > 100) {
    return res.status(400).json({
      success: false,
      message: "Discount rate must be between 0 and 100%",
    });
  }

  try {
    const business = await Business.findById(businessId);
    if (!business) {
      return res
        .status(404)
        .json({ success: false, message: "Business not found" });
    }

    if (!business.category.includes(categoryId)) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Invalid categoryId for this business",
        });
    }

    if (subCategoryId && !business.subCategory.includes(subCategoryId)) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Invalid subCategoryId for this business",
        });
    }

    const offer = new Offer({
      businessId,
      couponCode,
      discountRate,
      expirationDate,
      categoryId,
      subCategoryId,
    });

    await offer.save();
    res
      .status(201)
      .json({ success: true, message: "Offer created successfully!", offer });
  } catch (err) {
    res
      .status(500)
      .json({
        success: false,
        message: "Failed to create offer",
        error: err.message,
      });
  }
};

exports.getOffers = async (req, res) => {
  const { id: businessId } = req.params;

  try {
    console.log("Fetching offers for businessId:", businessId); // Debug log
    const offers = await Offer.find({
      businessId: new mongoose.Types.ObjectId(businessId),
    })
      .populate("categoryId", "name")
      .populate("subCategoryId", "name")
      .sort({ createdAt: -1 });

    console.log("Found offers:", offers); // Debug log
    if (!offers.length) {
      console.log("No offers found for this businessId");
    }

    // Add serviceName for display
    const offersWithService = offers.map((offer) => ({
      ...offer._doc,
      serviceName: offer.subCategoryId?.name || offer.categoryId.name,
    }));

    res.status(200).json({ success: true, offers: offersWithService });
  } catch (err) {
    console.error("Error in getOffers:", err);
    res
      .status(500)
      .json({
        success: false,
        message: "Failed to fetch offers.",
        error: err.message,
      });
  }
};

exports.deleteOffer = async (req, res) => {
  const { offerId } = req.params;
  const userId = req.user.id; // from authMiddleware

  try {
    const offer = await Offer.findById(offerId);
    if (!offer) {
      return res.status(404).json({
        success: false,
        message: "Offer not found",
      });
    }

    // Security: Only owner of the business can delete its offer
    const business = await Business.findById(offer.businessId);
    if (!business) {
      return res.status(404).json({ success: false, message: "Business not found" });
    }

    if (business.userId.toString() !== userId) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to delete this offer",
      });
    }

    await Offer.findByIdAndDelete(offerId);

    res.status(200).json({
      success: true,
      message: "Offer deleted successfully!",
    });
  } catch (err) {
    console.error("Error deleting offer:", err);
    res.status(500).json({
      success: false,
      message: "Failed to delete offer",
      error: err.message,
    });
  }
};