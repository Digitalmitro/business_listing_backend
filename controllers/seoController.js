// controllers/seoController.js
const PageSEO = require("../models/PageSeo");
const Business = require("../models/Business");

// ========================
// STATIC PAGES
// ========================

const getAllStaticPages = async (req, res) => {
  try {
    const pages = await PageSEO.find().sort({ pageKey: 1 });
    res.json(pages);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const getStaticPageByKey = async (req, res) => {
  try {
    const seo = await PageSEO.findOne({ pageKey: req.params.pageKey });
    if (!seo) {
      // Return 200 with fallback instead of 404 to avoid frontend errors
      return res.status(200).json({
        pageKey: req.params.pageKey,
        ...getFallbackSEO(req.params.pageKey),
        isFallback: true
      });
    }
    res.json(seo);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const updateStaticPageSEO = async (req, res) => {
  try {
    const updates = { ...req.body };

    if (req.files && req.files.bannerImage) {
      updates.bannerImage = req.files.bannerImage[0].filename;
    }

    // Handle keywords if they come as a JSON string from FormData
    if (typeof updates.keywords === "string") {
      try {
        updates.keywords = JSON.parse(updates.keywords);
      } catch (e) {
        updates.keywords = updates.keywords
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean);
      }
    }

    const updated = await PageSEO.findOneAndUpdate(
      { pageKey: req.params.pageKey },
      updates,
      { new: true, upsert: true }
    );
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ========================
// BUSINESS SEO
// ========================

const getBusinessesForSEO = async (req, res) => {
  try {
    const { search = "", page = 1, limit = 10 } = req.query;

    const query = search
      ? {
          $or: [
            { businessName: { $regex: search, $options: "i" } },
            { "contact.mobile": { $regex: search, $options: "i" } },
            { "contact.email": { $regex: search, $options: "i" } },
          ],
        }
      : {};

    const businesses = await Business.find(query)
      .select(
        "businessName seo address.city contact.mobile contact.email subscription"
      )
      .populate("subscription.packageId", "name") // ← Package name
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .sort({ businessName: 1 })
      .lean(); // ← Important: .lean() so we can modify data

    const total = await Business.countDocuments(query);

    // Format + Smart Package Logic
    const formatted = businesses.map((b) => {
      let displayPackage = "Free";

      if (b.subscription && b.subscription.status === "active") {
        displayPackage = b.subscription.packageName || "Premium";
      }
      // If status is pending/canceled/inactive → show "Free"

      return {
        _id: b._id,
        businessName: b.businessName,
        city: b.address?.city || "N/A",
        mobile: b.contact?.mobile?.[0] || "N/A",
        email: b.contact?.email?.[0] || "N/A",
        seo: b.seo || {},
        packageName: displayPackage,
        subscriptionStatus: b.subscription?.status || "none",
      };
    });

    res.json({
      businesses: formatted,
      totalPages: Math.ceil(total / limit),
      currentPage: +page,
      total,
    });
  } catch (err) {
    console.error("SEO Business fetch error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

const getBusinessSEO = async (req, res) => {
  try {
    const business = await Business.findById(req.params.id).select(
      "businessName seo address contact businessLogo"
    );

    if (!business) {
      return res.status(404).json({ message: "Business not found" });
    }

    // Return SEO or fallback
    const seo =
      business.seo && Object.keys(business.seo).length > 0
        ? business.seo
        : generateFallbackSEO(business);

    res.json({ seo });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const updateBusinessSEO = async (req, res) => {
  try {
    let seoPayload = req.body.seo;
    if (typeof seoPayload === "string") {
      seoPayload = JSON.parse(seoPayload);
    }
    const { title, description, keywords, ogImage, robots } = seoPayload;
    
    let finalKeywords = keywords;
    if (typeof keywords === "string") {
      try {
        finalKeywords = JSON.parse(keywords);
      } catch (e) {
        finalKeywords = keywords
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean);
      }
    }

    const updated = await Business.findByIdAndUpdate(
      req.params.id,
      {
        seo: {
          title,
          description,
          keywords: finalKeywords,
          ogImage,
          robots: robots || "index, follow",
        },
      },
      { new: true }
    ).select("seo");

    res.json(updated.seo);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ========================
// HELPER: Fallback SEO
// ========================

const generateFallbackSEO = (business) => ({
  title: `${business.businessName} - Best in ${business.address?.area || ""}, ${
    business.address?.city || ""
  }`,
  description: `Book appointment at ${business.businessName}. ${
    business.address?.streetName
  }, ${business.address?.area}. Contact: ${
    business.contact?.mobile?.[0] || ""
  }`,
  keywords: [
    business.businessName,
    business.address?.area,
    business.address?.city,
    "near me",
    "best",
  ],
  ogImage: business.businessLogo
    ? `${process.env.BASE_URL}/uploads/${business.businessLogo}`
    : `${process.env.BASE_URL}/default-og.jpg`,
  robots: "index, follow",
});

const getFallbackSEO = (pageKey) => {
  const fallbacks = {
    home: {
      title: "UrbanCitations - Local Services Near You",
      description: "Find trusted salons, doctors, plumbers in your city",
    },
    about: {
      title: "About Us - UrbanCitations",
      description: "India's fastest growing local business directory",
    },
    privacy: {
      title: "Privacy Policy",
      description: "We respect your privacy",
    },
    pricing: {
      title: "Pricing Plans | UrbanCitations - Grow Your Business",
      description: "Choose the perfect plan to boost your business visibility and connect with more customers.",
      bannerTitle: "Choose Your <span>Growth Plan</span>",
      bannerSubtitle: "Join <strong>5.9 Lakh+ businesses</strong> getting 10X more customers daily",
    },
  };
  return fallbacks[pageKey] || { title: "UrbanCitations", description: "" };
};

module.exports = {
  getAllStaticPages,
  getStaticPageByKey,
  updateStaticPageSEO,
  getBusinessesForSEO,
  getBusinessSEO,
  updateBusinessSEO,
};
