"use strict";

// Old defaults were saved as if they were the business's own uploads.
const DEFAULT_LOGO = "https://img.icons8.com/fluency/100/000000/organization.png";
const DEFAULT_PHOTO = "https://images.unsplash.com/photo-1486406146926-c627a92ad1ab";

function cleanBusinessLogo(value) {
  if (value == null || value === "") return "";
  if (typeof value !== "string") throw Object.assign(new Error("Invalid business logo"), { status: 400 });
  const logo = value.trim();
  return logo.split("?")[0] === DEFAULT_LOGO ? "" : logo;
}

function cleanBusinessPhotos(values) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
    throw Object.assign(new Error("Photos must be an array of image paths"), { status: 400 });
  }
  return [...new Set(values.map((value) => value.trim()).filter((value) => value && value.split("?")[0] !== DEFAULT_PHOTO))];
}

module.exports = { cleanBusinessLogo, cleanBusinessPhotos };
