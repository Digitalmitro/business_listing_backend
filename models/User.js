const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  full_name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true },
  password: { type: String },
  userImage: { type: String },
  isAgree: { type: Boolean, default: false },
  isSeller: { type: Boolean, default: false },
  businesses: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Business' }],
  phone: { type: String },
  dob: { type: Date },
  maritalStatus: { type: String, enum: ['Single', 'Married'] },
  city: { type: String },
  area: { type: String },
  pincode: { type: String },
  occupation: { type: String },
  otp: { type: String },
  otpExpiration: { type: Date },
  subscribedToEmails: { type: Boolean, default: false },
  timeZone: { type: String, default: 'Asia/Kolkata' },
  country: { type: String, default: 'India' },

  // ============ SUBSCRIPTION & PAYPAL ============
  subscription: {
    package: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PricingPackage',
      default: null
    },
    packageName: { type: String, enum: ['Silver', 'Gold', 'Platinum', 'Diamond'], default: 'Silver' },
    status: {
      type: String,
      enum: ['active', 'canceled', 'expired', 'pending', 'failed'],
      default: 'pending'
    },
    paypalSubscriptionId: { type: String }, // PayPal Subscription ID
    paypalOrderId: { type: String },       // For one-time payments (if used)
    startDate: { type: Date },
    endDate: { type: Date },               // Billing cycle end
    nextBillingDate: { type: Date },       // Auto-renewal date
    paymentMethod: { type: String, enum: ['paypal', 'razorpay', 'manual'], default: 'paypal' },
    isLifetime: { type: Boolean, default: false },
    trialUsed: { type: Boolean, default: false }
  },

  // Helper virtual: Is user subscribed to a paid plan?
  isPaidSubscriber: {
    type: Boolean,
    default: function () {
      return ['Gold', 'Platinum', 'Diamond'].includes(this.subscription.packageName) &&
             this.subscription.status === 'active';
    }
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Hash password
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  if (this.password) {
    this.password = await bcrypt.hash(this.password, 12);
  }
  next();
});

userSchema.methods.comparePassword = function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password || '');
};

// Virtual: Check if subscription is active
userSchema.virtual('hasActiveSubscription').get(function () {
  return this.subscription.status === 'active' &&
         this.subscription.endDate > new Date();
});

module.exports = mongoose.model('User', userSchema);