const Review = require("../models/Review");
const Business = require("../models/Business");

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
      { $match: { businessId: mongoose.Types.ObjectId(businessId) } },
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

    res.status(201).json({ message: "Review added successfully!", review });
  } catch (err) {
    if (err.code === 11000) {
      res
        .status(400)
        .json({ error: "You have already reviewed this business." });
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
