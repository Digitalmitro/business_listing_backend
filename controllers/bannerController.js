// controllers/bannerController.js
const Banner = require("../models/Banner");

// CREATE BANNER
exports.createBanner = async (req, res) => {
  try {
    const { title, link = "", priority = 10, isActive = true } = req.body;

    if (!title?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Title is required",
      });
    }

    if (!req.files?.image?.[0]) {
      return res.status(400).json({
        success: false,
        message: "Main banner image is required",
      });
    }

    // Local upload path
    const imageUrl = `${req.protocol}://${req.get("host")}/uploads/${
      req.files.image[0].filename
    }`;
    const bgImage = req.files.bgImage?.[0]
      ? `${req.protocol}://${req.get("host")}/uploads/${
          req.files.bgImage[0].filename
        }`
      : "";

    const newBanner = new Banner({
      title: title.trim(),
      imageUrl,
      bgImage,
      link: link.trim(),
      priority: Number(priority),
      isActive: isActive === "true" || isActive === true,
    });

    await newBanner.save();

    res.status(201).json({
      success: true,
      message: "Banner created successfully",
      banner: newBanner,
    });
  } catch (error) {
    console.error("Create banner error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create banner",
      error: error.message,
    });
  }
};

// GET ALL ACTIVE BANNERS
exports.getBanners = async (req, res) => {
  try {
    const banners = await Banner.find({ isActive: true })
      .sort({ priority: -1, createdAt: -1 })
      .select("-__v");

    res.status(200).json(banners);
  } catch (error) {
    console.error("Get banners error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch banners",
    });
  }
};

// UPDATE BANNER
exports.updateBanner = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = {};

    if (req.body.title !== undefined) updates.title = req.body.title.trim();
    if (req.body.link !== undefined) updates.link = req.body.link.trim();
    if (req.body.priority !== undefined)
      updates.priority = Number(req.body.priority);
    if (req.body.isActive !== undefined)
      updates.isActive = req.body.isActive === "true";

    if (req.files?.image?.[0]) {
      updates.imageUrl = `${req.protocol}://${req.get("host")}/uploads/${
        req.files.image[0].filename
      }`;
    }
    if (req.files?.bgImage?.[0]) {
      updates.bgImage = `${req.protocol}://${req.get("host")}/uploads/${
        req.files.bgImage[0].filename
      }`;
    }

    const updated = await Banner.findByIdAndUpdate(id, updates, {
      new: true,
      runValidators: true,
    });

    if (!updated) {
      return res
        .status(404)
        .json({ success: false, message: "Banner not found" });
    }

    res.json({
      success: true,
      message: "Banner updated successfully",
      banner: updated,
    });
  } catch (error) {
    console.error("Update error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// DELETE BANNER
exports.deleteBanner = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await Banner.findByIdAndDelete(id);

    if (!deleted) {
      return res
        .status(404)
        .json({ success: false, message: "Banner not found" });
    }

    res.json({ success: true, message: "Banner deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
