const mongoose = require("mongoose");
const { ObjectId } = mongoose.Types;

// Safe ObjectId converter — handles string, comma-separated, array, invalid cases
const toObjectIdArray = (value) => {
  if (!value) return [];

  let ids = [];

  // Case 1: Already an array
  if (Array.isArray(value)) {
    ids = value;
  }
  // Case 2: Comma-separated string → "id1,id2,id3"
  else if (typeof value === "string" && value.includes(",")) {
    ids = value.split(",").map(id => id.trim());
  }
  // Case 3: Single string ID
  else if (typeof value === "string") {
    ids = [value.trim()];
  }
  // Case 4: Anything else → ignore
  else {
    return [];
  }

  // Filter valid ObjectIds & convert to ObjectId type
  return ids
    .filter(id => id && ObjectId.isValid(id))  // Remove empty/null/invalid
    .map(id => new ObjectId(id));
};

module.exports = toObjectIdArray;