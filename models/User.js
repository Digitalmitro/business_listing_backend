// backend/models/User.js
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const socialAccountSubSchema = new mongoose.Schema(
  {
    isConnected: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ["not_connected", "connected", "expired", "revoked"],
      default: "not_connected",
    },
    platformUserId: { type: String },
    platformUsername: { type: String },
    profileName: { type: String },
    profileImageUrl: { type: String },
    accessToken: { type: String }, // Encrypted AES-256-GCM
    refreshToken: { type: String }, // Encrypted AES-256-GCM
    tokenExpiry: { type: Date },
    connectedAt: { type: Date },
    scopes: [{ type: String }],
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    full_name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: { type: String },
    userImage: { 
      type: String, 
      default: "https://img.icons8.com/bubbles/100/000000/user.png" 
    },
    isAgree: { type: Boolean, default: true },
    isSeller: { type: Boolean, default: false },
    businesses: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Business",
      },
    ],
    phone: { type: String, trim: true },
    dob: { type: Date },
    maritalStatus: { type: String, enum: ["single", "married", "divorced"] },
    city: { type: String },
    area: { type: String },
    pincode: { type: String },
    occupation: { type: String },
    otp: { type: String },
    otpExpiration: { type: Date },
    subscribedToEmails: { type: Boolean, default: true },
    timeZone: { type: String, default: "Asia/Kolkata" },
    country: { type: String, default: "India" },
    googleBusinessProfile: {
      isConnected: { type: Boolean, default: false },
      googleAccountId: { type: String },
      googleEmail: { type: String },
      accessToken: { type: String }, // Encrypted AES-256-GCM
      refreshToken: { type: String }, // Encrypted AES-256-GCM
      tokenExpiry: { type: Date },
      selectedProfileId: { type: String },
      lastFetchedProfile: { type: mongoose.Schema.Types.Mixed },
      connectedAt: { type: Date },
    },
    socialMediaAccounts: {
      facebook: { type: socialAccountSubSchema, default: () => ({}) },
      instagram: { type: socialAccountSubSchema, default: () => ({}) },
      linkedin: { type: socialAccountSubSchema, default: () => ({}) },
      twitter: { type: socialAccountSubSchema, default: () => ({}) },
      pinterest: { type: socialAccountSubSchema, default: () => ({}) },
    },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Hash password before saving
userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  if (this.password) {
    this.password = await bcrypt.hash(this.password, 12);
  }
  next();
});

// Compare password method
userSchema.methods.comparePassword = async function (candidatePassword) {
  if (!this.password) return false;
  return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model("User", userSchema);
