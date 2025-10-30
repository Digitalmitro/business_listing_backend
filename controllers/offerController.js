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
