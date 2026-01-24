const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const ClaimSchema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  businessName: { type: String, required: true },
  address: {
    blockName: String,
    streetName: String,
    area: String,
    landmark: String,
    pincode: String,
    city: String,
    country: String,
    state: String,
  },
  contact: {
    contactDetails: [
      {
        title: { type: String, enum: ["Mr", "Mrs"], required: true },
        name: { type: String, required: true },
        designation: String,
        mobileNumbers: [String],
        whatsappNumbers: [String],
        emails: [String],
      },
    ],
  },
  businessTiming: {
    isOpen24Hours: { type: Boolean, default: false },
    daysOfWeek: {
      type: [String],
      enum: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
      default: [],
    },
    schedule: {
      type: Map,
      of: [
        {
          openAt: { type: String, required: true },
          closeAt: { type: String, required: true },
        },
      ],
      default: {},
    },
  },
  categories: [{ type: Schema.Types.ObjectId, ref: "Category" }],
  subCategories: [{ type: Schema.Types.ObjectId, ref: "SubCategory" }],
  businessLogo: String,
  photos: [String],
  kyc: {
    country: { type: String },
    documents: { type: Map, of: String },
  },
  kycVerified: { type: Boolean, default: false },
  kycVerifiedAt: { type: Date },
  status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

ClaimSchema.index({ businessId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model("Claim", ClaimSchema);