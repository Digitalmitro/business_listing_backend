const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// Business Schema
const BusinessSchema = new Schema(
  {
    businessName: { type: String, required: true },
    description: { type: String },
    isBlocked: { type: Boolean, default: false },
    isAdmin: { type: Boolean, default: false },
    businessLogo: { 
      type: String, 
      default: "https://img.icons8.com/fluency/100/000000/organization.png" 
    },
    address: {
      blockName: { type: String },
      streetName: { type: String },
      area: { type: String },
      landmark: { type: String },
      pincode: { type: String, required: true },
      city: { type: String, required: true },
      country: { type: String, required: true },
      state: { type: String, required: true },
    },
    addressString: { type: String },
    location: {
      type: {
        type: String,
        enum: ["Point"],
        default: "Point",
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        required: true,
      },
    },
    contact: {
      customerName: { type: String }, // Deprecated
      mobile: { type: [String] }, // Deprecated, no validation
      whatsapp: { type: [String] }, // Deprecated, no validation
      email: { type: [String] }, // Deprecated
      contactDetails: [
        {
          title: { type: String, enum: ["Mr", "Mrs"], required: true },
          name: { type: String, required: true },
          designation: { type: String },
          mobileNumbers: { type: [String], required: true },
          whatsappNumbers: { type: [String] },
          emails: { type: [String] },
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
    category: [
      {
        type: Schema.Types.ObjectId,
        ref: "Category",
        required: true,
      },
    ],
    subCategory: [
      {
        type: Schema.Types.ObjectId,
        ref: "SubCategory",
      },
    ],
    importedCategory: { type: String, default: "" },
    importedSubcategory: { type: String, default: "" },
    photos: {
      type: [String],
      default: ["https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?q=80&w=1000&auto=format&fit=crop"]
    },
    rating: { type: Number, default: 0 },
    totalReviews: { type: Number, default: 0 },
    verified: { type: Boolean, default: false },
    trust: { type: Boolean, default: false },
    claimed: { type: Boolean, default: false },
    enquiryCount: { type: Number, default: 0 },
    openUntil: { type: String },
    yearsOfEstablishment: { type: Number, default: 0 },
    servicesTypes: { type: [String] },
    hygiene: { type: String, default: "" },
    businessSummary: { type: String },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    subscription: {
      packageId: { type: Schema.Types.ObjectId, ref: "PricingPackage", default: null },
      packageName: { type: String, default: "Free" },
      subscriptionId: { type: String, default: null }, // Razorpay/PayPal subscription ID
      orderId: { type: String, default: null },       // For one-time payments
      startDate: { type: Date },
      endDate: { type: Date },
      status: {
        type: String,
        enum: ["active", "inactive", "canceled", "pending"],
        default: "inactive"
      },
      paymentGateway: { type: String, enum: ["razorpay", "paypal"], default: null },
    },
    kyc: {
      country: { type: String, enum: ["USA", "Europe", "India"] },
      documents: { type: Map, of: String, default: {} },
      status: {
        type: String,
        enum: ["pending", "verified", "rejected"],
        default: "pending",
      },
      rejectionReason: { type: String },
      verifiedAt: { type: Date },
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User", // Assuming a User model exists
    },
    seo: {
      title: { type: String, trim: true },
      description: { type: String, trim: true },
      keywords: [{ type: String, trim: true }],
      ogImage: { type: String },
      robots: {
        type: String,
        enum: ["index, follow", "noindex, nofollow"],
        default: "index, follow",
      },
      canonicalUrl: { type: String },
    },
    // New section for social links, website, and video URL
    socialLinks: {
      type: Map,
      of: String,
      default: {},
      // Example usage: { facebook: "https://facebook.com/business", instagram: "https://instagram.com/business" }
    },
    website: {
      type: String,
      // Optional validation for URL format can be added (e.g., using a regex or validator plugin)
    },
    videoUrl: {
      type: String,
      // Optional validation for video URL (e.g., YouTube/Vimeo) can be added
    },
    profileCompletionScore: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    needsGeocoding: {
      type: Boolean,
      default: false,
    },
    geocodingError: {
      type: String,
      default: null,
    },
    importIdentityKey: {
      type: String,
      index: { unique: true, sparse: true },
    },
    importMetadata: {
      batch: {
        type: Schema.Types.ObjectId,
        ref: "BusinessImportBatch",
      },
      row: {
        type: Schema.Types.ObjectId,
        ref: "BusinessImportRow",
      },
      rowNumber: { type: Number },
      sourceFileName: { type: String },
      importedAt: { type: Date },
    },
  },
  { timestamps: true }
);

// ✅ Indexes for performance
BusinessSchema.index({ businessName: 1 });
BusinessSchema.index({ "address.city": 1 });
BusinessSchema.index({ "address.pincode": 1 });
BusinessSchema.index({ location: "2dsphere" });

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

  // Ensure contactDetails is initialized as an empty array if undefined
  if (!this.contact) this.contact = {};
  if (!this.contact.contactDetails) this.contact.contactDetails = [];

  next();
});

// Simplified pre-save hook to allow same number within one contact
BusinessSchema.pre("save", async function (next) {
  const contactDetails = this.contact.contactDetails || [];

  // Collect numbers by contact index to allow duplicates within the same contact
  const numberMap = new Map();
  contactDetails.forEach((cd, index) => {
    const numbers = [
      ...(cd.mobileNumbers || []).filter((num) => num && num.trim()),
      ...(cd.whatsappNumbers || []).filter((num) => num && num.trim()),
    ];
    numbers.forEach((num) => {
      if (!numberMap.has(num)) {
        numberMap.set(num, new Set([index]));
      } else {
        numberMap.get(num).add(index);
      }
    });
  });

  // Check for duplicates across different contact persons
  for (let [num, indices] of numberMap) {
    if (indices.size > 1) {
      return next(
        new Error(
          `Number ${num} is used by multiple contact persons within the same business.`
        )
      );
    }
  }

  // Check uniqueness across businesses (excluding current document)
  const allNumbers = Array.from(numberMap.keys());
  if (allNumbers.length > 0) {
    const existing = await mongoose.models.Business.findOne({
      _id: { $ne: this._id },
      $or: [
        { "contact.contactDetails.mobileNumbers": { $in: allNumbers } },
        { "contact.contactDetails.whatsappNumbers": { $in: allNumbers } },
      ],
    });
    if (existing) {
      return next(
        new Error("One or more numbers are already in use by another business.")
      );
    }
  }

  if (!this.seo?.canonicalUrl && this._id) {
    this.seo = this.seo || {};
    this.seo.canonicalUrl = `${
      process.env.FRONTEND_URL || "https://urbancitations.com"
    }/serviceprofile/${this._id}`;
  }

  next();
});

module.exports = mongoose.model("Business", BusinessSchema);
