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
      return res.status(404).json({
        message: "Page not found",
        fallback: getFallbackSEO(req.params.pageKey),
      });
    }
    res.json(seo);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const updateStaticPageSEO = async (req, res) => {
  try {
    const updated = await PageSEO.findOneAndUpdate(
      { pageKey: req.params.pageKey },
      req.body,
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
      .select("businessName seo address.city contact.mobile contact.email")
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .sort({ businessName: 1 });

    const total = await Business.countDocuments(query);

    res.json({
      businesses,
      totalPages: Math.ceil(total / limit),
      currentPage: +page,
      total,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
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
    const seo = business.seo && Object.keys(business.seo).length > 0
      ? business.seo
      : generateFallbackSEO(business);

    res.json({ seo });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const updateBusinessSEO = async (req, res) => {
  try {
    const { title, description, keywords, ogImage, robots } = req.body.seo;

    const updated = await Business.findByIdAndUpdate(
      req.params.id,
      {
        seo: {
          title,
          description,
          keywords,
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
  title: `${business.businessName} - Best in ${business.address?.area || ""}, ${business.address?.city || ""}`,
  description: `Book appointment at ${business.businessName}. ${business.address?.streetName}, ${business.address?.area}. Contact: ${business.contact?.mobile?.[0] || ""}`,
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
    home: { title: "UrbanCitations - Local Services Near You", description: "Find trusted salons, doctors, plumbers in your city" },
    about: { title: "About Us - UrbanCitations", description: "India's fastest growing local business directory" },
    privacy: { title: "Privacy Policy", description: "We respect your privacy" },
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