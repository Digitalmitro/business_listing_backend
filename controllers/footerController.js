const FooterLinks = require("../models/FooterLinks");

exports.updateFooterLinks = async (req, res) => {
  try {
    const { about, discover, business, social, languages } = req.body;

    const updated = await FooterLinks.findOneAndUpdate(
      { active: true },
      {
        about,
        discover,
        business,
        social,
        languages,
        updatedAt: new Date(),
      },
      { upsert: true, new: true }
    );

    res.json({
      success: true,
      message: "Footer links updated successfully!",
      data: updated,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Update failed" });
  }
};

exports.getFooterLinks = async (req, res) => {
  try {
    const footerData = await FooterLinks.findOne({ active: true });

    if (!footerData) {
      return res
        .status(404)
        .json({ success: false, message: "Footer links not found" });
    }

    res.json({
      success: true,
      footerLinks: {
        about: footerData.about,
        discover: footerData.discover,
        business: footerData.business,
        social: footerData.social && Object.keys(footerData.social).length > 0 ? footerData.social : {
          facebook: "https://www.facebook.com/urbancitationsusa/",
          twitter: "https://x.com/urbarcitation",
          instagram: "https://www.instagram.com/urbancitations/",
          linkedin: "https://www.linkedin.com/company/urban-citations/",
          pinterest: "https://www.pinterest.com/urbancitations/",
          youtube: "https://www.youtube.com/@UrbanCitations",
        },
        languages: footerData.languages || ["English"],
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};
