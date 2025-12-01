const mongoose = require("mongoose");
const { Schema } = mongoose;

// Define the schema for TopCountry
const TopCountrySchema = new Schema({
  name: {
    type: String,
    required: true,
    unique: true,
  },
  imageUrl: {
    type: String,
    required: true,
  },
  gallery: [
    {
      image: { type: String, required: true },
      caption: { type: String, default: "" },
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
  mustVisitPlaces: [
    {
      name: String,
      description: { type: String, default: "" },
      image: String,
    },
  ],
  funFacts: [String],
  restaurants: [
    {
      name: String,
      description: { type: String, default: "" },
      image: String,
    },
  ],
  hotels: [
    {
      name: String,
      description: { type: String, default: "" },
      image: String,
    },
  ],
});

// Create a model based on the schema
module.exports = mongoose.model("TopCountry", TopCountrySchema);
