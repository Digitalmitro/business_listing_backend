const mongoose = require("mongoose");

const geocodeCacheSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["forward", "reverse"],
      required: true,
    },
    query: {
      type: String,
      required: true,
      index: true,
    },
    data: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
  },
  { timestamps: true }
);

// Compound index for faster lookups
geocodeCacheSchema.index({ type: 1, query: 1 });

module.exports = mongoose.model("GeocodeCache", geocodeCacheSchema);
