const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// Top Banner Category Schema
const TopBannerCategorySchema = new Schema({
  title: {
    type: String,
    required: true
  },
  paragraph: {
    type: String,
    required: true
  },
  imageUrl: {
    type: String,
    required: true  // URL for the banner image
  },
  bgColor:{
    type: String,
    default:'#FF5733'
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

module.exports = mongoose.model('TopBannerCategory', TopBannerCategorySchema);
