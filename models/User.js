// backend/models/User.js (Updated)
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  full_name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String },
  userImage: { type: String },
  isAgree: { type: Boolean, default: false },
  isSeller: { type: Boolean, default: false },
  businesses: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Business' }],
  phone: { type: String, required: false },
  dob: { type: Date, required: false },
  maritalStatus: { type: String, enum: ['Single', 'Married'], required: false },
  city: { type: String, required: false },
  area: { type: String, required: false },
  pincode: { type: String, required: false },
  occupation: { type: String, required: false },
  otp: { type: String },
  otpExpiration: { type: Date },
  subscribedToEmails: { type: Boolean, default: false }, // New field for subscription status
  timeZone: {
    type: String,
    default: 'UTC',
    // Example values: 'Asia/Kolkata', 'America/New_York', 'America/Los_Angeles'
  },
  country: {
    type: String,
    trim: true,
    // Example values: 'India', 'United States'
  },
});

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

userSchema.methods.comparePassword = function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', userSchema);