const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const PopularSearchSchema = new Schema({
  title: { type: String, required: true },
  imageUrl: { type: String, required: true },
  categoryId: { type: Schema.Types.ObjectId, ref: "Category", required: true },
  priority: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model("PopularSearch", PopularSearchSchema);
