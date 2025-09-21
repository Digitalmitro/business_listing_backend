const mongoose = require("mongoose");

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
  subCategoryId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'SubCategory', 
    default: null // Optional, links to a specific subCategory
  }, 
  categoryId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Category', 
    required: true // Links to a category, defaults to business's category if no subCategory
  }, 
  createdAt: { 
    type: Date, 
    default: Date.now 
  } 
});

// Prevent duplicate reviews (one user can review a business only once)
reviewSchema.index({ businessId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model("Review", reviewSchema);
