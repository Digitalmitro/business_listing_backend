const axios = require("axios");

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
  if (featureType === "address") {
    address.road = feature.text;
    address.house_number = feature.address;
  }

  return address;
};

/**
 * Reverse Geocoding: Lat/Lon to Address
 */
const reverseGeocode = async (lat, lon) => {
  const provider = process.env.GEOCODING_PROVIDER || "locationiq";

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
    return {
      place_id: feature.id,
      display_name: feature.place_name,
      lat: String(feature.center[1]),
      lon: String(feature.center[0]),
      address: normalizeMapboxAddress(feature),
    };
  }

  // Default to LocationIQ
  const response = await axios.get("https://us1.locationiq.com/v1/reverse", {
    params: {
      key: process.env.LOCATIONIQ_API_KEY,
      lat,
      lon,
      format: "json",
    },
  });
  return response.data;
};

/**
 * Forward Geocoding: Address to Lat/Lon
 */
const forwardGeocode = async (address) => {
  const provider = process.env.GEOCODING_PROVIDER || "locationiq";

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
    return [
      {
        place_id: feature.id,
        display_name: feature.place_name,
        lat: String(feature.center[1]),
        lon: String(feature.center[0]),
        address: normalizeMapboxAddress(feature),
      },
    ];
  }

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
  return response.data;
};

module.exports = {
  reverseGeocode,
  forwardGeocode,
};
