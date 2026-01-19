const axios = require("axios");
const GeocodeCache = require("../models/GeocodeCache");

/**
 * Normalizes Mapbox features context into a LocationIQ-like address object.
 */
const normalizeMapboxAddress = (feature) => {
  const address = {};
  const context = feature.context || [];

  // Mapbox context elements have ids like 'place.123', 'region.456', etc.
  context.forEach((item) => {
    const [type] = item.id.split(".");
    switch (type) {
      case "country":
        address.country = item.text;
        address.country_code = item.short_code;
        break;
      case "region":
        address.state = item.text;
        break;
      case "place":
        address.city = item.text;
        break;
      case "locality":
        address.suburb = item.text;
        break;
      case "neighborhood":
        address.neighbourhood = item.text;
        break;
      case "postcode":
        address.postcode = item.text;
        break;
      case "district":
        address.city_district = item.text;
        break;
    }
  });

  // Handle the main feature text
  const [featureType] = feature.id.split(".");
  switch (featureType) {
    case "address":
      address.road = feature.text;
      address.house_number = feature.address;
      break;
    case "region":
      address.state = feature.text;
      break;
    case "place":
      address.city = feature.text;
      break;
    case "locality":
      address.suburb = feature.text;
      break;
    case "postcode":
      address.postcode = feature.text;
      break;
  }

  return address;
};

/**
 * Reverse Geocoding: Lat/Lon to Address
 */
const reverseGeocode = async (lat, lon) => {
  const query = `${lat},${lon}`;
  
  // Check cache first
  try {
    const cached = await GeocodeCache.findOne({ type: "reverse", query });
    if (cached) {
      return cached.data;
    }
  } catch (error) {
    console.error("Cache lookup error:", error);
  }

  const provider = process.env.GEOCODING_PROVIDER || "locationiq";
  let result;

  if (provider === "mapbox") {
    const accessToken = process.env.MAPBOX_ACCESS_TOKEN;
    if (!accessToken) throw new Error("Mapbox Access Token is missing");

    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lon},${lat}.json`;
    const response = await axios.get(url, {
      params: {
        access_token: accessToken,
        types: "address,place,locality,neighborhood",
        limit: 1,
      },
    });

    if (!response.data.features || response.data.features.length === 0) {
      throw new Error("No results found");
    }

    const feature = response.data.features[0];
    result = {
      place_id: feature.id,
      display_name: feature.place_name,
      lat: String(feature.center[1]),
      lon: String(feature.center[0]),
      address: normalizeMapboxAddress(feature),
    };
  } else {
    // Default to LocationIQ
    const response = await axios.get("https://us1.locationiq.com/v1/reverse", {
      params: {
        key: process.env.LOCATIONIQ_API_KEY,
        lat,
        lon,
        format: "json",
      },
    });
    result = response.data;
  }

  // Save to cache
  if (result) {
    try {
      await GeocodeCache.create({ type: "reverse", query, data: result });
    } catch (error) {
      console.error("Cache save error:", error);
    }
  }

  return result;
};

/**
 * Forward Geocoding: Address to Lat/Lon
 */
const forwardGeocode = async (address) => {
  if (!address) return [];
  const query = address.toLowerCase().trim();

  // Check cache first
  try {
    const cached = await GeocodeCache.findOne({ type: "forward", query });
    if (cached) {
      return cached.data;
    }
  } catch (error) {
    console.error("Cache lookup error:", error);
  }

  const provider = process.env.GEOCODING_PROVIDER || "locationiq";
  let result;

  if (provider === "mapbox") {
    const accessToken = process.env.MAPBOX_ACCESS_TOKEN;
    if (!accessToken) throw new Error("Mapbox Access Token is missing");

    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json`;
    const response = await axios.get(url, {
      params: {
        access_token: accessToken,
        limit: 1,
      },
    });

    if (!response.data.features || response.data.features.length === 0) {
      throw new Error("No results found");
    }

    const feature = response.data.features[0];
    result = [
      {
        place_id: feature.id,
        display_name: feature.place_name,
        lat: String(feature.center[1]),
        lon: String(feature.center[0]),
        address: normalizeMapboxAddress(feature),
      },
    ];
  } else {
    // Default to LocationIQ
    const response = await axios.get("https://us1.locationiq.com/v1/search", {
      params: {
        key: process.env.LOCATIONIQ_API_KEY,
        q: address,
        format: "json",
        limit: 1,
        addressdetails: 1,
      },
    });
    result = response.data;
  }

  // Save to cache
  if (result && result.length > 0) {
    try {
      await GeocodeCache.create({ type: "forward", query, data: result });
    } catch (error) {
      console.error("Cache save error:", error);
    }
  }

  return result;
};

module.exports = {
  reverseGeocode,
  forwardGeocode,
};
