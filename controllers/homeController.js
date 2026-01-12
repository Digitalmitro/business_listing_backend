const Business = require("../models/Business");
const TopBannerCategory = require("../models/TopBannerCategory");
const PopularSearch = require("../models/PopularSearch");


exports.getPopularSearches = async (req, res) => {
  try {
    const services = await PopularSearch.find({ isActive: true })
      .select("title imageUrl categoryId")
      .populate("categoryId", "name slug")
      .sort({ priority: -1 })
      .limit(8)
      .lean();

    res.json({ popularSearches: services });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.getFeaturedListings = async (req, res) => {
  try {
    const businesses = await Business.find({
    //   "subscription.status": "active",
      verified: true,
      rating: { $gte: 4 },
    })
      .select(
        "businessName businessLogo address.city address.area photos rating totalReviews"
      )
      .sort({ rating: -1, totalReviews: -1 })
      .limit(6)
      .lean();

    res.json({ featuredListings: businesses });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
