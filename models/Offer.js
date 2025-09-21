const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const OfferSchema = new Schema({
  businessId: { 
    type: Schema.Types.ObjectId, 
    ref: 'Business', 
    required: true 
  },
  couponCode: { 
    type: String, 
    required: true, 
    unique: true 
  },
  discountRate: { 
    type: Number, 
    required: true, 
    min: 0, 
    max: 100 
  },
  expirationDate: { 
    type: Date, 
    required: true 
  },
  categoryId: { 
    type: Schema.Types.ObjectId, 
    ref: 'Category', 
    required: true 
  },
  subCategoryId: { 
    type: Schema.Types.ObjectId, 
    ref: 'SubCategory', 
    default: null 
  },
  createdAt: { 
    type: Date, 
    default: Date.now 
  }
});

module.exports = mongoose.model('Offer', OfferSchema);