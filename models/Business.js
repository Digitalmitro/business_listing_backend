const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// Business Schema
const BusinessSchema = new Schema(
  {
    businessName: { type: String, required: true },
    description: { type: String },
    isBlocked: { type: Boolean, default: false },
    address: {
      blockName: { type: String },
      streetName: { type: String },
      area: { type: String },
      landmark: { type: String },
      pincode: { type: String, required: true },
      city: { type: String, required: true },
      state: { type: String, required: true },
    },
    addressString: { type: String },
    contact: {
      customerName: { type: String, required: true },
      mobile: {
        type: [String],
        required: true,
        validate: {
          validator: async function (value) {
            const existing = await mongoose.models.Business.findOne({
              "contact.mobile": { $in: value },
            });
            return !existing; // Ensure no matching mobile exists
          },
          message: "Mobile number(s) must be unique.",
        },
      },
      whatsapp: {
        type: [String],
        validate: {
          validator: async function (value) {
            const existing = await mongoose.models.Business.findOne({
              "contact.whatsapp": { $in: value },
            });
            return !existing; // Ensure no matching WhatsApp exists
          },
          message: "WhatsApp number(s) must be unique.",
        },
      },
      email: {
        type: [String],
        // validate: {
        //   validator: async function (value) {
        //     const existing = await mongoose.models.Business.findOne({
        //       "contact.email": { $in: value },
        //     });
        //     return !existing; // Ensure no matching email exists
        //   },
        //   message: "Email(s) must be unique.",
        // },
      },
    },
    // businessTiming: {
    //   weeksSet: {
    //     type: [String],
    //     enum: ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"],
    //     required: true
    //   },
    //   timing: [
    //     {
    //       day: {type: String, required: true},
    //       start: { type: String, required: true },
    //       end: { type: String, required: true },
    //     },
    //   ],
    // },
    businessTiming: {
      isOpen24Hours: {
        type: Boolean,
        default: false,
      },
      daysOfWeek: {
        type: [String],
        enum: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
        default: [],
      },
      schedule: {
        type: Map,
        of: [
          {
            openAt: { type: String, required: true }, // Format: "HH:MM" (e.g., "09:00")
            closeAt: { type: String, required: true }, // Format: "HH:MM" (e.g., "17:00")
          },
        ],
        default: {},
      },
    },
    category: {
      type: Schema.Types.ObjectId,
      ref: "Category",
      required: true,
    },
    subCategory: {
      type: Schema.Types.ObjectId,
      ref: "SubCategory",
      required: false,
    },
    photos: [{ type: String }],
    rating: {
      type: Number,
      default: 0,
    },
    totalReviews: {
      type: Number,
      default: 0,
    },
    verified: {
      type: Boolean,
      default: false,
    },
    trust: {
      type: Boolean,
      default: false,
    },
    claimed: {
      type: Boolean,
      default: false,
    },
    enquiryCount: {
      type: Number,
      default: 0,
    },
    openUntil: {
      type: String,
    },
    yearsOfEstablishment: {
      type: Number,
      default: 0,
    },
    servicesTypes: {
      type: [String],
    },
    hygiene: {
      type: String,
      default: "",
    },
    businessSummary: {
      type: String,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
    subscriptionActive: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

BusinessSchema.pre("save", function (next) {
  const address = this.address;
  const parts = [
    address.blockName,
    address.streetName,
    address.area,
    address.landmark,
    address.city,
    address.state,
    address.pincode,
  ];
  this.addressString = parts.filter(Boolean).join(", ");
  next();
});

module.exports = mongoose.model("Business", BusinessSchema);
