// models/Banner.js
const mongoose = require("mongoose");

const BannerSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    imageUrl: {
      type: String,
      required: true,
    },
    bgImage: {
      type: String,
      default: "",
    },
    link: {
      type: String,
      default: "",
    },
    priority: {
      type: Number,
      default: 10,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Banner", BannerSchema);
