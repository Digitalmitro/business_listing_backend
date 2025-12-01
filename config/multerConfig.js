// config/multerConfig.js
const multer = require("multer");
const path = require("path");

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "public/uploads/");
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + "-" + file.originalname);
  },
});

const upload = multer({ storage });

const dynamicUpload = (req, res, next) => {
  const fields = [
    { name: "icon", maxCountCount: 1 },
    { name: "galleryImages", maxCount: 30 },
  ];

  // MUST VISIT
  for (let i = 0; i < 20; i++) {
    fields.push({ name: `mustVisitPlacesImages_${i}`, maxCount: 1 });
  }

  // RESTAURANTS
  for (let i = 0; i < 20; i++) {
    fields.push({ name: `restaurantsImages_${i}`, maxCount: 1 });
  }

  // HOTELS
  for (let i = 0; i < 20; i++) {
    fields.push({ name: `hotelsImages_${i}`, maxCount: 1 });
  }

  upload.fields(fields)(req, res, next);
};

module.exports = { upload, dynamicUpload };
