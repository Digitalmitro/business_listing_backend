// controllers/topBannerCategoryController.js
const TopBannerCategory = require("../models/TopBannerCategory");
const mongoose = require("mongoose");

// CREATE
exports.createTopBannerCategory = async (req, res) => {
  try {
    const { title, paragraph, bgColor, priority = 0, categoryId } = req.body;

    // Validation
    if (!categoryId || !mongoose.Types.ObjectId.isValid(categoryId)) {
      return res.status(400).json({
        success: false,
        message: "Valid categoryId is required",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Image is required",
      });
    }

    const imageUrl = `${req.protocol}://${req.get("host")}/uploads/${
      req.file.filename
    }`;

    const newItem = new TopBannerCategory({
      title: title ? title.trim() : undefined,
      paragraph: paragraph ? paragraph.trim() : undefined,
      imageUrl,
      bgColor: bgColor || "#FF5733",
      priority: Number(priority),
      categoryId: new mongoose.Types.ObjectId(categoryId),
      isActive: true,
    });

    await newItem.save();

    res.status(201).json({
      success: true,
      message: "Top banner category created successfully",
      data: newItem,
    });
  } catch (error) {
    console.error("Create top banner error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create top banner category",
      error: error.message,
    });
  }
};

// GET ALL ACTIVE (Public)
exports.getAllTopBannerCategories = async (req, res) => {
  try {
    const items = await TopBannerCategory.find({ isActive: true })
      .populate("categoryId", "name slug") // ← Category name + slug bhi aayega
      .sort({ priority: -1, createdAt: -1 })
      .select("-__v");

    res.status(200).json(items);
  } catch (error) {
    console.error("Get top banners error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch top banner categories",
    });
  }
};

// UPDATE (Admin)
exports.updateTopBannerCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, paragraph, bgColor, priority, categoryId, isActive } =
      req.body;

    const updates = {};

    if (title !== undefined) updates.title = title.trim();
    if (paragraph !== undefined) updates.paragraph = paragraph.trim();
    if (bgColor !== undefined) updates.bgColor = bgColor;
    if (priority !== undefined) updates.priority = Number(priority);
    if (isActive !== undefined)
      updates.isActive = isActive === "true" || isActive === true;

    // Validate categoryId if provided
    if (categoryId) {
      if (!mongoose.Types.ObjectId.isValid(categoryId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid categoryId",
        });
      }
      updates.categoryId = new mongoose.Types.ObjectId(categoryId);
    }

    // Handle image update
    if (req.file) {
      updates.imageUrl = `${req.protocol}://${req.get("host")}/uploads/${
        req.file.filename
      }`;
    }

    const updated = await TopBannerCategory.findByIdAndUpdate(id, updates, {
      new: true,
      runValidators: true,
    }).populate("categoryId", "name slug");

    if (!updated) {
      return res
        .status(404)
        .json({ success: false, message: "Top banner not found" });
    }

    res.json({
      success: true,
      message: "Updated successfully",
      data: updated,
    });
  } catch (error) {
    console.error("Update top banner error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// DELETE (Admin)
exports.deleteTopBannerCategory = async (req, res) => {
  try {
    const { id } = req.params;

    const deleted = await TopBannerCategory.findByIdAndDelete(id);

    if (!deleted) {
      return res
        .status(404)
        .json({ success: false, message: "Top banner not found" });
    }

    res.json({ success: true, message: "Deleted successfully" });
  } catch (error) {
    console.error("Delete error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};
