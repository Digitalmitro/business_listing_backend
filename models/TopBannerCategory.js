// models/TopBannerCategory.js
const mongoose = require("mongoose");

const TopBannerCategorySchema = new mongoose.Schema(
  {
    title: {
      type: String,
      trim: true,
    },
    paragraph: {
      type: String,
      trim: true,
    },
    imageUrl: {
      type: String,
      required: true,
    },
    bgColor: {
      type: String,
      default: "#FF5733",
    },
    slug: {
      type: String,
      unique: true,
      sparse: true,
    },
    priority: {
      type: Number,
      default: 0, // Higher = top mein dikhega
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    // YE SABSE ZAROORI HAI — CATEGORY LINK!
    categoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: true, // ← Compulsory
    },
  },
  {
    timestamps: true,
  }
);

// Auto-generate slug from title
TopBannerCategorySchema.pre("save", function (next) {
  if (this.title && (this.isModified("title") || !this.slug)) {
    this.slug = this.title
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }
  next();
});

// Optional: Index for performance
TopBannerCategorySchema.index({ categoryId: 1, isActive: 1, priority: -1 });

module.exports = mongoose.model("TopBannerCategory", TopBannerCategorySchema);
