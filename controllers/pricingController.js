// controllers/pricingController.js
const PricingPackage = require('../models/PricingPackage');

// @desc    Get all active packages
// @route   GET /api/pricing
// @access  Public
const getAllPackages = async (req, res) => {
  try {
    const packages = await PricingPackage.find({ isActive: true }).sort({ priceINR: 1 });
    res.json({ packages });
  } catch (error) {
    console.error("GET ALL PACKAGES ERROR:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Get package by ID
// @route   GET /api/pricing/:id
// @access  Public
const getPackageById = async (req, res) => {
  try {
    const package = await PricingPackage.findById(req.params.id);
    if (!package) {
      return res.status(404).json({ message: "Package not found" });
    }
    res.json(package);
  } catch (error) {
    console.error("GET PACKAGE BY ID ERROR:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Create new package
// @route   POST /api/pricing
// @access  Private/Admin
const createPackage = async (req, res) => {
  try {
    const { name, priceINR, priceUSD, priceGBP, features } = req.body;

    if (!name || !['Silver', 'Gold', 'Platinum', 'Diamond'].includes(name)) {
      return res.status(400).json({ message: "Valid package name required" });
    }

    const packageExists = await PricingPackage.findOne({ name });
    if (packageExists) {
      return res.status(400).json({ message: "Package already exists" });
    }

    const newPackage = await PricingPackage.create({
      name,
      priceINR: priceINR || 0,
      priceUSD: priceUSD || 0,
      priceGBP: priceGBP || 0,
      features: features || {}
    });

    res.status(201).json({
      message: "Package created successfully",
      package: newPackage,
    });
  } catch (error) {
    console.error("CREATE PACKAGE ERROR:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Update package
// @route   PUT /api/pricing/:id
// @access  Private/Admin
const updatePackage = async (req, res) => {
  try {
    const { name, priceINR, priceUSD, priceGBP, features, isActive } = req.body;

    const package = await PricingPackage.findById(req.params.id);
    if (!package) {
      return res.status(404).json({ message: "Package not found" });
    }

    // Prevent duplicate name
    if (name && name !== package.name) {
      const nameExists = await PricingPackage.findOne({ name });
      if (nameExists) {
        return res.status(400).json({ message: "Package name already exists" });
      }
    }

    package.name = name || package.name;
    package.priceINR = priceINR !== undefined ? priceINR : package.priceINR;
    package.priceUSD = priceUSD !== undefined ? priceUSD : package.priceUSD;
    package.priceGBP = priceGBP !== undefined ? priceGBP : package.priceGBP;
    package.features = features || package.features;
    package.isActive = isActive !== undefined ? isActive : package.isActive;

    const updatedPackage = await package.save();

    res.json({
      message: "Package updated",
      package: updatedPackage,
    });
  } catch (error) {
    console.error("UPDATE PACKAGE ERROR:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Delete package
// @route   DELETE /api/pricing/:id
// @access  Private/Admin
const deletePackage = async (req, res) => {
  try {
    const package = await PricingPackage.findById(req.params.id);
    if (!package) {
      return res.status(404).json({ message: "Package not found" });
    }

    await package.deleteOne();
    res.json({ message: "Package removed" });
  } catch (error) {
    console.error("DELETE PACKAGE ERROR:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Toggle package active status
// @route   PATCH /api/pricing/:id/toggle
// @access  Private/Admin
const togglePackageActive = async (req, res) => {
  try {
    const package = await PricingPackage.findById(req.params.id);
    if (!package) {
      return res.status(404).json({ message: "Package not found" });
    }

    package.isActive = !package.isActive;
    await package.save();

    res.json({
      message: "Status updated",
      isActive: package.isActive,
    });
  } catch (error) {
    console.error("TOGGLE ACTIVE ERROR:", error);
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = {
  getAllPackages,
  getPackageById,
  createPackage,
  updatePackage,
  deletePackage,
  togglePackageActive,
};