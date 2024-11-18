const TopBannerCategory = require('../models/TopBannerCategory');

// Create Top Banner Category
exports.createTopBannerCategory = async (req, res) => {
  try {
    const { title, paragraph } = req.body;
   
    if (!title || !paragraph || !req.file) {
      return res.status(400).json({ message: "Title, paragraph, and image are required" });
    }

    const imageUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;

    const topBannerCategory = new TopBannerCategory({ title, paragraph, imageUrl });
    await topBannerCategory.save();

    res.status(201).json({ message: "Top Banner Category created successfully", topBannerCategory });
  } catch (error) {
    res.status(500).json({ message: "Error creating banner category", error: error.message });
  }
};

// Get All Top Banner Categories
exports.getAllTopBannerCategories = async (req, res) => {
  try {
    const topBannerCategories = await TopBannerCategory.find().select("-__v -createdAt -updatedAt");
    res.status(200).json(topBannerCategories );
  } catch (error) {
    res.status(500).json({ message: "Error retrieving banner categories", error: error.message });
  }
};
