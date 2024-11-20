const multer = require('multer');
const path = require('path');

// Set up multer storage for local file storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'public/uploads/'); // Save files in 'public/uploads' directory
  },
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + file.originalname;
    cb(null, uniqueName);  // Unique file name to avoid overwrites
  }
});

const upload = multer({ storage });

module.exports = { upload };

