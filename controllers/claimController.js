const Claim = require("../models/Claim");
const Business = require("../models/Business");
const fs = require("fs").promises;
const path = require("path");
const mongoose = require("mongoose");
const { addJob } = require("../utils/queue");

const submitClaim = async (req, res) => {
  try {
    const { businessId } = req.params;
    const userId = req.user.id;

    // Parse businessData from request body
    let businessData;
    try {
      businessData = JSON.parse(req.body.businessData);
    } catch (parseError) {
      return res
        .status(400)
        .json({ message: "Invalid businessData format", error: parseError.message });
    }

    const {
      businessName,
      address,
      contact,
      businessTiming,
      categories,
      subCategories,
    } = businessData;

    // ✅ Validate business exists
    const existingBusiness = await Business.findById(businessId);
    if (!existingBusiness) {
      return res.status(404).json({ message: "Business not found" });
    }

    // ✅ Check if user already submitted a claim for this business
    const existingClaim = await Claim.findOne({ businessId, userId });

    if (existingClaim) {
      // Return proper response based on claim status
      if (existingClaim.status === "pending") {
        return res.status(409).json({
          message: "You already have a pending claim for this business.",
          status: "pending",
          claimId: existingClaim._id,
        });
      } else if (existingClaim.status === "approved") {
        return res.status(409).json({
          message: "This business is already claimed by you.",
          status: "approved",
          claimId: existingClaim._id,
        });
      } else if (existingClaim.status === "rejected") {
        // Optionally allow resubmission if rejected
        await Claim.deleteOne({ _id: existingClaim._id });
      }
    }

    // ✅ Handle file uploads
    let businessLogo = existingBusiness.businessLogo;
    let photos = existingBusiness.photos || [];
    if (req.files) {
      if (req.files.businessLogo) {
        businessLogo = path.join("uploads", req.files.businessLogo[0].filename);
      }
      if (req.files.photos) {
        photos = req.files.photos.map((file) => path.join("uploads", file.filename));
      }
    }

    // ✅ Create new claim
    const claim = new Claim({
      businessId,
      userId: new mongoose.Types.ObjectId(userId),
      businessName,
      address,
      contact,
      businessTiming,
      categories,
      subCategories,
      businessLogo,
      photos,
      status: "pending",
    });

    await claim.save();

    res.status(201).json({
      message: "Claim submitted successfully. Awaiting admin approval.",
      claimId: claim._id,
    });
  } catch (error) {
    console.error("Error submitting claim:", error);
    res.status(500).json({ message: "Failed to submit claim", error: error.message });
  }
};


const getClaims = async (req, res) => {
  try {
    const claims = await Claim.find()
      .populate("userId", "full_name email") // populate as usual
      .lean(); // return plain JS objects so we can modify easily

    // Map through claims and rename `full_name` to `name`
    const modifiedClaims = claims.map((claim) => {
      if (claim.userId && claim.userId.full_name) {
        claim.userId = {
          ...claim.userId,
          name: claim.userId.full_name,
        };
        delete claim.userId.full_name;
      }
      return claim;
    });

    res.status(200).json(modifiedClaims);
  } catch (error) {
    console.error("Error fetching claims:", error);
    res.status(500).json({ message: "Failed to fetch claims", error });
  }
};


const updateClaimStatus = async (req, res) => {
  try {
    const { claimId } = req.params;
    const { status } = req.body;

    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const claim = await Claim.findById(claimId);
    if (!claim) {
      return res.status(404).json({ message: "Claim not found" });
    }

    claim.status = status;
    claim.updatedAt = Date.now();
    await claim.save();

    // Add claim email job to queue
    await addJob("claim-email", {
      claimId: claim._id,
      status: claim.status,
    });

    if (status === "approved") {
      const { _id, ...claimData } = claim.toObject(); // exclude _id
      await Business.findByIdAndUpdate(claim.businessId, {
        ...claimData,
        claimed: true,
        verified: true,
        updatedAt: Date.now(),
      });
    }

    res.status(200).json({ message: `Claim ${status}`, claim });
  } catch (error) {
    console.error("Error updating claim status:", error);
    res.status(500).json({ message: "Failed to update claim status", error });
  }
};

const getClaimById = async (req, res) => {
  try {
    const { claimId } = req.params;

    const claim = await Claim.findById(claimId)
      .populate("userId", "name email")
      .populate("businessId", "businessName address contact categories subCategories businessLogo photos");

    if (!claim) {
      return res.status(404).json({ message: "Claim not found" });
    }

    res.status(200).json(claim);
  } catch (error) {
    console.error("Error fetching claim details:", error);
    res.status(500).json({ message: "Failed to fetch claim details", error });
  }
};


module.exports = { submitClaim, getClaims, updateClaimStatus, getClaimById };