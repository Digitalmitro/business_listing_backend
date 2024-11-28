const mongoose = require('mongoose');
const { Schema } = mongoose;

// Define the schema for TopCountry
const TopCountrySchema = new Schema({
  name: {
    type: String,
    required: true,
    unique: true
  },
  imageUrl: {
    type: String,
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

// Create a model based on the schema
module.exports = mongoose.model('TopCountry', TopCountrySchema);
