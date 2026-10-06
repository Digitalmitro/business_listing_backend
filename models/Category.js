const mongoose = require("mongoose");
const Schema = mongoose.Schema;
const { ImageAssetSchema } = require("./schemas/imageAsset");
const { registerImageField } = require("../services/imageStorageService");

const CategorySchema = new Schema({
  name: {
    type: String,
    required: true,
    unique: true,
  },
  slug: {
    type: String,
  },
  description: {
    type: String,
  },
  // Display URL of the icon. For Cloudinary-stored icons this equals icon.url;
  // legacy records keep an absolute /uploads/<file> URL or the default placeholder.
  iconUrl: {
    type: String,
    required: true,
    default: "https://img.icons8.com/fluency/512/business.png",
  },
  // Cloudinary asset behind iconUrl (absent for legacy and default icons).
  icon: {
    type: ImageAssetSchema,
    required: false,
  },
  bgImage: {
    type: String,
    required: false,
    default: "https://images.unsplash.com/photo-1557683311-eac922347aa1?q=80&w=1000&auto=format&fit=crop"
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

const Category = mongoose.model("Category", CategorySchema);
registerImageField(Category, "icon");

module.exports = Category;
