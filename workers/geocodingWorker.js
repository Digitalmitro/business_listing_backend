const { Worker } = require("bullmq");
const { redisConnection } = require("../utils/queue");
const Business = require("../models/Business");
const geocodingService = require("../services/geocodingService");

const geocodingWorker = new Worker(
  "geocoding-batch",
  async (job) => {
    const { businessId } = job.data;
    try {
      const business = await Business.findById(businessId);
      if (!business) {
        console.error(`Business ${businessId} not found for geocoding`);
        return;
      }

      // Construct address for geocoding
      const { streetName, area, city, state, country, pincode } = business.address;
      const addressString = [streetName, area, city, state, country, pincode]
        .filter(Boolean)
        .join(", ");

      console.log(`Geocoding business: ${business.businessName} at ${addressString}`);

      const results = await geocodingService.forwardGeocode(addressString);

      if (results && results.length > 0) {
        const { lat, lon } = results[0];
        
        business.location = {
          type: "Point",
          coordinates: [Number(lon), Number(lat)],
        };
        business.needsGeocoding = false;
        business.geocodingError = null;
        await business.save();
        
        console.log(`Successfully geocoded ${business.businessName}: [${lon}, ${lat}]`);
      } else {
        throw new Error("No geocoding results found for address");
      }
    } catch (error) {
      console.error(`Geocoding error for business ${businessId}:`, error.message);
      
      // Update business with error status
      await Business.findByIdAndUpdate(businessId, {
        $set: { 
          geocodingError: error.message,
          needsGeocoding: true // Keep true so we can retry or identify it later
        }
      });
      
      throw error; // Rethrow for BullMQ retry
    }
  },
  { 
    connection: redisConnection,
    concurrency: 2 // Low concurrency to stay within API rate limits
  }
);

module.exports = geocodingWorker;
