const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// SubCategory Schema
const SubCategorySchema = new Schema({
  id: {
    type: Number,
  },
  name: {
    type: String,
    required: true,
  },
  iconUrl: {
    type: String,
    required: true,
    default: "https://img.icons8.com/fluency/512/business.png",
  },
  slug: {
    type: String,
    unique: true,
    trim: true,
  },
  description: {
    type: String,
  },
  bgImage: {
    type: String,
    required: false,
    default: "https://images.unsplash.com/photo-1557683311-eac922347aa1?q=80&w=1000&auto=format&fit=crop"
  },
  category: {
    type: Schema.Types.ObjectId,
    ref: "Category",
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// Prevent same name under same category
SubCategorySchema.index({ name: 1, category: 1 }, { unique: true });

// Auto-generate slug before saving
SubCategorySchema.pre("save", function (next) {
  if (this.isModified("name") || !this.slug) {
    this.slug = this.name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .trim();
  }
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model("SubCategory", SubCategorySchema);
