const mongoose = require('mongoose');
require('dotenv').config();
const Business = require('../models/Business');

async function seed() {
  try {
    await mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log("Connected to DB");
    
    // Millbrook, Alabama Coordinates
    const AL_LAT = 32.4800; // Latitude
    const AL_LON = -86.3730; // Longitude

    // Target Business ID from your previous message
    const businessId = "696a85cfee87f2ce5820e2ce"; 

    const result = await Business.updateOne(
      { _id: businessId },
      { 
        $set: { 
          "location.coordinates": [AL_LON, AL_LAT], // Note: MongoDB uses [Longitude, Latitude]
          needsGeocoding: false,
          geocodingError: null
        } 
      }
    );

    if (result.matchedCount > 0) {
      console.log(`✅ Successfully seeded coordinates for Alabama Custom Trucks (${businessId})`);
      console.log(`Updated Location: [${AL_LON}, ${AL_LAT}]`);
    } else {
      console.log(`❌ Business with ID ${businessId} not found.`);
    }

    process.exit(0);
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
}

seed();
