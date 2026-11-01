// controllers/pricingController.js
const PricingPackage = require('../models/PricingPackage');
const { PACKAGE_NAMES, REMINDER_KEYS } = require('../models/PricingPackage');
const { mergeEntitlements } = require('../services/planEntitlements');

const ENTITLEMENT_FLAGS = ['ownSender', 'bookingEmails', 'customTemplates', 'crmLeadEmails', 'aiEmails', 'journeys', 'googleBusiness'];

/** Keeps only well-formed feature groups ({ title, items: [{ label, value }] }). */
function cleanFeatureGroups(groups) {
  if (!Array.isArray(groups)) return undefined;
  return groups
    .filter((g) => g && typeof g.title === 'string' && g.title.trim())
    .slice(0, 30)
    .map((g) => ({
      title: g.title.trim().slice(0, 80),
      items: (Array.isArray(g.items) ? g.items : [])
        .filter((i) => i && typeof i.label === 'string' && i.label.trim() && i.value !== undefined && String(i.value).trim())
        .slice(0, 100)
        .map((i) => ({ label: i.label.trim().slice(0, 120), value: String(i.value).trim().slice(0, 40) })),
    }));
}

function cleanEntitlements(input) {
  if (!input || typeof input !== 'object') return undefined;
  const out = {};
  for (const flag of ENTITLEMENT_FLAGS) if (input[flag] !== undefined) out[flag] = Boolean(input[flag]);
  if (Array.isArray(input.bookingReminders)) out.bookingReminders = REMINDER_KEYS.filter((k) => input.bookingReminders.includes(k));
  return out;
}

function priceOrUndefined(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

/** Adds the effective entitlements (stored values over the plan defaults). */
function withEffectiveEntitlements(pkg) {
  const plain = typeof pkg.toObject === 'function' ? pkg.toObject() : pkg;
  return { ...plain, effectiveEntitlements: mergeEntitlements(plain.name, plain.entitlements) };
}

// @desc    Get all active packages
// @route   GET /api/pricing
// @access  Public
const getAllPackages = async (req, res) => {
  try {
    const packages = await PricingPackage.find({ isActive: true }).sort({ sortOrder: 1, priceUSD: 1 }).lean();
    res.json({ packages: packages.map(withEffectiveEntitlements) });
  } catch (error) {
    console.error("GET ALL PACKAGES ERROR:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Get every package, including drafts (inactive), so admins can re-activate them
// @route   GET /api/pricing/admin/all
// @access  Private/Admin
const getAllPackagesForAdmin = async (req, res) => {
  try {
    const packages = await PricingPackage.find({}).sort({ sortOrder: 1, priceUSD: 1 }).lean();
    res.json({ packages: packages.map(withEffectiveEntitlements), packageNames: PACKAGE_NAMES });
  } catch (error) {
    console.error("GET ADMIN PACKAGES ERROR:", error);
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
    const { name, priceINR, priceUSD, priceGBP, features, featureIcons, featureGroups, entitlements, billingPeriod, sortOrder } = req.body;

    if (!name || !PACKAGE_NAMES.includes(name)) {
      return res.status(400).json({ message: `Package name must be one of: ${PACKAGE_NAMES.join(", ")}` });
    }
    const prices = [priceINR, priceUSD, priceGBP].map(priceOrUndefined);
    if (prices.some((p) => Number.isNaN(p))) {
      return res.status(400).json({ message: "Prices must be numbers of 0 or more" });
    }

    const packageExists = await PricingPackage.findOne({ name });
    if (packageExists) {
      return res.status(400).json({ message: "Package already exists" });
    }

    const newPackage = await PricingPackage.create({
      name,
      priceINR: prices[0] || 0,
      priceUSD: prices[1] || 0,
      priceGBP: prices[2] || 0,
      billingPeriod: billingPeriod === 'year' ? 'year' : 'month',
      sortOrder: Number.isFinite(Number(sortOrder)) ? Number(sortOrder) : PACKAGE_NAMES.indexOf(name) + 1,
      featureGroups: cleanFeatureGroups(featureGroups) || [],
      entitlements: cleanEntitlements(entitlements),
      features: features || {},
      featureIcons: featureIcons || {}
    });

    res.status(201).json({
      message: "Package created successfully",
      package: withEffectiveEntitlements(newPackage),
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
    const { name, priceINR, priceUSD, priceGBP, features, featureIcons, isActive, featureGroups, entitlements, billingPeriod, sortOrder } = req.body;

    const package = await PricingPackage.findById(req.params.id);
    if (!package) {
      return res.status(404).json({ message: "Package not found" });
    }

    if (name && !PACKAGE_NAMES.includes(name)) {
      return res.status(400).json({ message: `Package name must be one of: ${PACKAGE_NAMES.join(", ")}` });
    }
    const prices = [priceINR, priceUSD, priceGBP].map(priceOrUndefined);
    if (prices.some((p) => Number.isNaN(p))) {
      return res.status(400).json({ message: "Prices must be numbers of 0 or more" });
    }

    // Prevent duplicate name
    if (name && name !== package.name) {
      const nameExists = await PricingPackage.findOne({ name });
      if (nameExists) {
        return res.status(400).json({ message: "Package name already exists" });
      }
    }

    package.name = name || package.name;
    package.priceINR = prices[0] !== undefined ? prices[0] : package.priceINR;
    package.priceUSD = prices[1] !== undefined ? prices[1] : package.priceUSD;
    package.priceGBP = prices[2] !== undefined ? prices[2] : package.priceGBP;
    package.features = features || package.features;
    package.featureIcons = featureIcons || package.featureIcons;
    package.isActive = isActive !== undefined ? Boolean(isActive) : package.isActive;
    if (billingPeriod) package.billingPeriod = billingPeriod === 'year' ? 'year' : 'month';
    if (sortOrder !== undefined && Number.isFinite(Number(sortOrder))) package.sortOrder = Number(sortOrder);
    const groups = cleanFeatureGroups(featureGroups);
    if (groups) package.featureGroups = groups;
    const ents = cleanEntitlements(entitlements);
    if (ents) package.entitlements = { ...(package.entitlements?.toObject?.() || package.entitlements || {}), ...ents };

    const updatedPackage = await package.save();

    res.json({
      message: "Package updated",
      package: withEffectiveEntitlements(updatedPackage),
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

// @desc    Upload feature icon
// @route   POST /api/pricing/upload-feature-icon
// @access  Private/Admin
const uploadFeatureIcon = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }
    res.json({
      message: "Icon uploaded successfully",
      url: req.file.filename,
    });
  } catch (error) {
    console.error("UPLOAD ICON ERROR:", error);
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = {
  getAllPackages,
  getAllPackagesForAdmin,
  getPackageById,
  createPackage,
  updatePackage,
  deletePackage,
  togglePackageActive,
  uploadFeatureIcon,
};