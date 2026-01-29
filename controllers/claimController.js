const Claim = require("../models/Claim");
const Business = require("../models/Business");
const User = require("../models/User");
const fs = require("fs").promises;
const path = require("path");
const mongoose = require("mongoose");
const { addJob } = require("../utils/queue");
const { notifyAdmins } = require("../helpers/notificationHelper");

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
    let kycDocumentsMap = new Map();

    if (req.files) {
      if (req.files.businessLogo) {
        businessLogo = req.files.businessLogo[0].filename;
      }
      if (req.files.photos) {
        photos = req.files.photos.map((file) => file.filename);
      }
      if (req.files.kycDocuments) {
        const { docMapping } = businessData.kyc || {};
        req.files.kycDocuments.forEach((file) => {
          const docName = docMapping?.[file.originalname] || file.originalname;
          kycDocumentsMap.set(docName, path.basename(file.filename));
        });
      }
    }

    // ✅ Handle KYC metadata from businessData
    let kycData = null;
    if (businessData.kyc) {
      kycData = {
        country: businessData.kyc.country,
        documents: kycDocumentsMap
      };
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
      kyc: kycData,
      status: "pending",
    });

    await claim.save();

    // Notify Admins about business claim
    await notifyAdmins({
      title: "Business Claim Submitted",
      description: `A new claim has been submitted for ${businessName} by ${req.user.full_name || "a user"}.`,
      link: `/view-claim/${claim._id}`,
      category: "claims",
    });

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


const getUserClaims = async (req, res) => {
  try {
    const userId = req.user.id;
    const claims = await Claim.find({ userId })
      .populate("businessId", "businessName addressString businessLogo")
      .lean();

    res.status(200).json(claims);
  } catch (error) {
    console.error("Error fetching user claims:", error);
    res.status(500).json({ message: "Failed to fetch claims", error: error.message });
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
    if (status === "approved") {
      claim.kycVerified = true;
      claim.kycVerifiedAt = new Date();
      claim.updatedAt = Date.now();
      await claim.save();

      // 0. Find the previous owner if any
      const previousBusiness = await Business.findById(claim.businessId);
      const previousOwnerId = previousBusiness?.userId;

      // 1. Update the business record
      const businessUpdates = {
        userId: claim.userId, // Set the new owner
        claimed: true,
        verified: true,
        updatedAt: Date.now(),
      };

      // If claim has KYC info, sync it to the business and mark KYC as verified
      if (claim.kyc && claim.kyc.country) {
        businessUpdates.kyc = {
          country: claim.kyc.country,
          documents: claim.kyc.documents,
          status: "verified",
          verifiedAt: new Date(),
        };
      }

      // Sync logo and photos from claim if they exist
      if (claim.businessLogo) businessUpdates.businessLogo = claim.businessLogo;
      if (claim.photos && claim.photos.length > 0)
        businessUpdates.photos = claim.photos;

      await Business.findByIdAndUpdate(claim.businessId, businessUpdates);

      // 2. Remove this business from ALL users who might have it in their businesses array (Cleanup stale data)
      await User.updateMany(
        { businesses: claim.businessId },
        { $pull: { businesses: claim.businessId } }
      );

      // 3. Update Previous Owner's isSeller status if they have no more businesses
      if (previousOwnerId && previousOwnerId.toString() !== claim.userId.toString()) {
        const prevUser = await User.findById(previousOwnerId);
        if (prevUser && prevUser.businesses.length === 0) {
          prevUser.isSeller = false;
          await prevUser.save();
        }
      }

      // 4. Update New Owner record to include this business
      await User.findByIdAndUpdate(claim.userId, {
        $addToSet: { businesses: claim.businessId },
        $set: { isSeller: true },
      });
    }

    // Add claim email job to queue
    await addJob("claim-email", {
      claimId: claim._id,
      status: claim.status,
    });

    res.status(200).json({ message: `Claim ${status}`, claim });
  } catch (error) {
    console.error("Error updating claim status:", error);
    res.status(500).json({ message: "Failed to update claim status", error });
  }
};

const getClaimById = async (req, res) => {
  try {
    const { claimId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(claimId)) {
      return res.status(400).json({ message: "Invalid claim ID format" });
    }

    const claim = await Claim.findById(claimId)
      .populate("userId", "name email")
      .populate("businessId", "businessName address contact categories subCategories businessLogo photos")
      .lean();

    if (!claim) {
      return res.status(404).json({ message: "Claim not found" });
    }

    res.status(200).json(claim);
  } catch (error) {
    console.error("Error fetching claim details:", error);
    res.status(500).json({ message: "Failed to fetch claim details", error });
  }
};


const syncApprovedClaims = async (req, res) => {
  try {
    const approvedClaims = await Claim.find({ status: "approved" });
    let updatedCount = 0;

    for (const claim of approvedClaims) {
      // 0. Find current owner to see if it needs pull
      const currentBusiness = await Business.findById(claim.businessId);
      const previousOwnerId = currentBusiness?.userId;

      // 1. Update Business record (Ownership only)
      await Business.findByIdAndUpdate(claim.businessId, {
        userId: claim.userId,
        claimed: true,
        verified: true,
        updatedAt: Date.now(),
      });

      // 2. Remove this business from ALL users who might have it in their businesses array (Cleanup stale data)
      await User.updateMany(
        { businesses: claim.businessId },
        { $pull: { businesses: claim.businessId } }
      );

      // 3. Update Previous Owner record (if changed)
      if (previousOwnerId && previousOwnerId.toString() !== claim.userId.toString()) {
        const prevUser = await User.findById(previousOwnerId);
        if (prevUser && prevUser.businesses.length === 0) {
          prevUser.isSeller = false;
          await prevUser.save();
        }
      }

      // 4. Update User record (New owner)
      await User.findByIdAndUpdate(claim.userId, {
        $addToSet: { businesses: claim.businessId },
        $set: { isSeller: true },
      });

      updatedCount++;
    }

    res.status(200).json({
      success: true,
      message: `Successfully synced ${updatedCount} approved claims.`,
    });
  } catch (error) {
    console.error("Error syncing claims:", error);
    res.status(500).json({ success: false, message: "Failed to sync claims", error: error.message });
  }
};

module.exports = { submitClaim, getClaims, updateClaimStatus, getClaimById, syncApprovedClaims, getUserClaims };