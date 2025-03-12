const mongoose = require('mongoose');

const PlanSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    enum: ['Platinum', 'Premium', 'Gold','Silver'], 
  },
  description: {
    type: String,
    required: true,
  },
  discount: {
    type: Number, 
    required: true,
    min: 0,
    max: 100,
  },
  pricePerDay: {
    type: Number, 
    required: true,
    min: 0,
  },
  searchVisibilityMultiplier: {
    type: Number, 
    required: true,
    min: 1,
  },
  features: [
    {
      name: { type: String, required: true }, 
      value: { type: Boolean, default: false }, 
    },
  ],
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

const Plan = mongoose.model('Plan', PlanSchema);

module.exports = Plan;
