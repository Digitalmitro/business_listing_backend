const mongoose = require('mongoose');
require('dotenv').config();
const Business = require('../models/Business');
const { addJob } = require('../utils/queue');

async function sync() {
  try {
    await mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log("Connected to DB");
    
    // Find businesses with needsGeocoding: true OR coordinates [0,0]
    const pending = await Business.find({ 
      $or: [
        { "location.coordinates": [0, 0] },
        { needsGeocoding: true }
      ]
    });

    console.log(`Found ${pending.length} businesses needing geocoding.`);

    let queued = 0;
    for (const biz of pending) {
      await addJob("geocoding-batch", { businessId: biz._id });
      queued++;
    }

    console.log(`Successfully queued ${queued} jobs.`);
    process.exit(0);
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
}

sync();
