const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// SubCategory Schema
const SubCategorySchema = new Schema({
  name: {
    type: String,
    required: true
  },
  iconUrl: {
    type: String,
    required: true
  },
  slug: {
    type: String,
  },
  description: {
    type: String,
  },
  bgImage: {
    type: String,
    required: false
  },
  category: {
    type: Schema.Types.ObjectId,
    ref: 'Category',
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('SubCategory', SubCategorySchema);
