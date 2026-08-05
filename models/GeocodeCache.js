const mongoose = require("mongoose");

const configuredTtlDays = Number.parseInt(process.env.GEOCODE_CACHE_TTL_DAYS, 10);
const ttlDays = Number.isInteger(configuredTtlDays) && configuredTtlDays > 0
  ? Math.min(configuredTtlDays, 365)
  : 7;

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
    },
    data: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    expireAt: {
      type: Date,
      default: () => new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000),
      required: true,
    },
  },
  { timestamps: true }
);

// Compound index for faster lookups
geocodeCacheSchema.index({ type: 1, query: 1 });
geocodeCacheSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("GeocodeCache", geocodeCacheSchema);
