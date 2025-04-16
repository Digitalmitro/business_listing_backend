const cloudinary = require("cloudinary").v2;
const multer = require("multer");

require("dotenv").config();

// ✅ Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ✅ Multer Memory Storage
const upload = multer({ storage: multer.memoryStorage() });

// ✅ Function to Upload to Cloudinary
const uploadToCloudinary = (fileBuffer, folder = "uploads") => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { 
        folder,
        resource_type: "auto",
        chunk_size: 6 * 1024 * 1024, // Upload in 6MB chunks
        timeout: 60000, // Increase timeout
        max_bytes: 50 * 1024 * 1024 // Increase file size limit to 50MB
      },
      (error, uploadedFile) => {
        if (error) {
          reject(error);
        } else {
          resolve(uploadedFile.secure_url);
        }
      }
    );
    uploadStream.end(fileBuffer);
  });
};

module.exports = { upload, uploadToCloudinary ,cloudinary };

