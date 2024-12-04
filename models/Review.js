const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema({
  businessId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Business', 
    required: true 
  }, 
  userId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  }, 
  rating: { 
    type: Number, 
    required: true, 
    min: 1, 
    max: 5 
  }, 
  comment: { 
    type: String, 
    maxlength: 500 
  }, 
  createdAt: { 
    type: Date, 
    default: Date.now 
  } 
});

// Prevent duplicate reviews (one user can review a business only once)
reviewSchema.index({ businessId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('Review', reviewSchema);

