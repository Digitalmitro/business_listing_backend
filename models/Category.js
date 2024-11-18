const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// Category Schema
const CategorySchema = new Schema({
  name: {
    type: String,
    required: true,
    unique: true
  },
  iconUrl: {
    type: String,
    required: true
  },
  bgImage: {
    type: String, // URL for the background image
    required: false // Optional field
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

module.exports = mongoose.model('Category', CategorySchema);
