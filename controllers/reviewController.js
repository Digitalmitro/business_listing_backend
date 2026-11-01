const Review = require("../models/Review");
const Business = require("../models/Business");
const { default: mongoose } = require("mongoose");

exports.createReview = async (req, res) => {
  const { businessId, rating, comment, subCategoryId } = req.body;
  const userId = req.user.id;

  if (!businessId || !rating || !userId) {
    return res.status(400).json({
      success: false,
      message: "Missing required fields (businessId, rating, or userId)",
    });
  }

  try {
    // Fetch the business to get categoryId
    const business = await Business.findById(businessId);
    if (!business) {
      return res
        .status(404)
        .json({ success: false, message: "Business not found" });
    }

    // One review per user per business. The unique index on (businessId, userId) is the
    // last line of defence, but it only exists once `npm run indexes` has run
    // (config/db.js sets autoIndex:false), so check here too.
    if (await Review.exists({ businessId, userId })) {
      return res.status(400).json({
        success: false,
        error: "You have already reviewed this business.",
        message: "You have already reviewed this business.",
      });
    }

    // Default categoryId to the first category if multiple
    const categoryId = business.category[0]; // Assuming category is an array of ObjectIds

    const review = new Review({
      businessId,
      userId,
      rating,
      comment,
      categoryId,
      subCategoryId: subCategoryId || null, // Optional, set to null if not provided
    });

    await review.save();

    // Optimize aggregation using MongoDB aggregation
    const aggregationResult = await Review.aggregate([
      { $match: { businessId: new mongoose.Types.ObjectId(businessId) } },
      {
        $group: {
          _id: null,
          totalReviews: { $sum: 1 },
          avgRating: { $avg: "$rating" },
        },
      },
    ]);

    if (aggregationResult.length > 0) {
      const { totalReviews, avgRating } = aggregationResult[0];
      await Business.updateOne(
        { _id: businessId },
        {
          $set: {
            totalReviews,
            rating: avgRating,
          },
        }
      );
    } else {
      // If no reviews exist after saving, reset to 0 and default rating
      await Business.updateOne(
        { _id: businessId },
        {
          $set: {
            totalReviews: 0,
            rating: 0,
          },
        }
      );
    }

    // Tell the owner (in-app + email from the platform). Never blocks the review.
    try {
      const biz = await Business.findById(businessId).select("userId businessName").lean();
      if (biz?.userId && String(biz.userId) !== String(userId)) {
        const { createNotification } = require("../helpers/notificationHelper");
        await createNotification({
          recipientId: biz.userId,
          title: "New review",
          description: `${biz.businessName} received a ${rating}-star review.`,
          link: `/reviewsList/${businessId}`,
          category: "business",
        });
        const User = require("../models/User");
        const owner = await User.findById(biz.userId).select("email full_name").lean();
        if (owner?.email) {
          const sendMail = require("../services/sendMail");
          const stars = "★".repeat(Math.max(1, Math.min(5, Math.round(Number(rating)))));
          const safe = (v) => String(v || "").replace(/[<>&"]/g, "");
          await sendMail(
            owner.email,
            `New ${rating}-star review for ${safe(biz.businessName)}`,
            `<p>Hi ${safe(owner.full_name) || "there"},</p><p><strong>${safe(biz.businessName)}</strong> received a new review: ${stars}</p>${comment ? `<blockquote>${safe(comment).slice(0, 500)}</blockquote>` : ""}<p><a href="${(process.env.FRONTEND_URL || "https://urbancitations.com").replace(/\/+$/, "")}/reviewsList/${businessId}">See your reviews</a></p>`
          );
        }
      }
    } catch (notifyError) {
      console.warn("Review owner notification failed:", notifyError.message);
    }

    res.status(201).json({ message: "Review added successfully!", review });
  } catch (err) {
    if (err.code === 11000) {
      res
        .status(400)
        .json({ error: "You have already reviewed this business.", message: "You have already reviewed this business." });
    } else {
      res
        .status(500)
        .json({ error: "Failed to add review.", details: err.message });
    }
  }
};

exports.getReviews = async (req, res) => {
  const { businessId } = req.params;

  try {
    const reviews = await Review.find({ businessId })
      .populate("userId", "full_name")
      .populate("categoryId", "name")
      .populate("subCategoryId", "name")
      .sort({ createdAt: -1 });

    // Derive serviceName from subCategory or category
    const reviewsWithService = reviews.map((review) => ({
      ...review._doc,
      serviceName: review.subCategoryId?.name || review.categoryId.name,
    }));

    res.status(200).json(reviewsWithService);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch reviews." });
  }
};

exports.getAllBusinessReviews = async (req, res) => {
  try {
    const { businessIds } = req.body;
    if (!businessIds || !Array.isArray(businessIds)) {
      return res.status(400).json({ message: "businessIds array required" });
    }

    const reviews = await Review.find({ businessId: { $in: businessIds } })
      .populate("userId", "full_name userImage")
      .sort({ createdAt: -1 })
      .limit(50);

    res.json({ success: true, reviews });
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch reviews" });
  }
};
