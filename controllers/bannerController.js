const Banner = require('../models/Banner');

// Create Banner API
exports.createBanner = async (req, res) => {
  try {
    const { title } = req.body;

    // Validate required fields
    if (!title || !req.file) {
      return res.status(400).json({ message: "Please provide both title and banner image" });
    }

    // Save banner with title and Cloudinary image URL
    const banner = new Banner({
      title,
      imageUrl: result.secure_url
    });
    await banner.save();

    res.status(201).json({ message: "Banner created successfully", banner });
  } catch (error) {
    res.status(500).json({ message: "An error occurred while creating the banner", error: error.message });
  }
};

// Get All Banners API
exports.getAllBanners = async (req, res) => {
    try {
      const banners = await Banner.find();
      res.status(200).json({ banners });
    } catch (error) {
      res.status(500).json({ message: "An error occurred while retrieving banners", error: error.message });
    }
  };
  