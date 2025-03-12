const Banner = require('../models/Banner');

// Create Banner API
exports.createBanner = async (req, res) => {
  try {
    const { title } = req.body;
    
    // Validate required fields
    if (!title || !req.file) {
      return res.status(400).json({ message: "Please provide both title and banner image" });
    }
    const banerUrl = ''
    if (req.files.image) {
      // iconUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
      const iconUpload = req.files.image[0];
      banerUrl = iconUpload.location;
  }
    const banner = new Banner({
      title,
      imageUrl: banerUrl
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
      const banners = await Banner.find().select("-__v -createdAt -updatedAt");
      res.status(200).json(banners);
    } catch (error) {
      res.status(500).json({ message: "An error occurred while retrieving banners", error: error.message });
    }
  };
  