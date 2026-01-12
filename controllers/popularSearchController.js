const PopularSearch = require("../models/PopularSearch");

exports.getAllPopularSearches = async (req, res) => {
  try {
    const popularSearches = await PopularSearch.find()
      .populate("categoryId", "name")
      .sort({ priority: -1 });
    res.json(popularSearches);
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.createPopularSearch = async (req, res) => {
  try {
    const { title, categoryId, priority, isActive } = req.body;
    let imageUrl = "";
    if (req.file) {
      imageUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;
    }

    const newPopularSearch = new PopularSearch({
      title,
      imageUrl,
      categoryId,
      priority,
      isActive
    });

    await newPopularSearch.save();
    res.status(201).json({ message: "Popular search created successfully", popularSearch: newPopularSearch });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.updatePopularSearch = async (req, res) => {
  try {
    const { title, categoryId, priority, isActive } = req.body;
    const updateData = { title, categoryId, priority, isActive };

    if (req.file) {
      updateData.imageUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;
    }

    const updatedPopularSearch = await PopularSearch.findByIdAndUpdate(req.params.id, updateData, { new: true });
    res.json({ message: "Popular search updated successfully", popularSearch: updatedPopularSearch });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.deletePopularSearch = async (req, res) => {
  try {
    await PopularSearch.findByIdAndDelete(req.params.id);
    res.json({ message: "Popular search deleted successfully" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
