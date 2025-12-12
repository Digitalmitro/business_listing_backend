// controllers/enquiryController.js

const Enquiry = require("../models/Enquiry");

// CREATE ENQUIRY — Already perfect
exports.createEnquiry = async (req, res) => {
  try {
    const { name, phone, interest, location, businessId } = req.body;

    if (
      !name ||
      !phone ||
      !interest ||
      !Array.isArray(interest) ||
      interest.length === 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Name, phone, and at least one interest are required.",
      });
    }

    const cleanPhone = phone.toString().replace(/\D/g, "").slice(-10);
    if (cleanPhone.length !== 10) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid 10-digit Indian mobile number.",
      });
    }

    const cleanedInterests = interest
      .map((i) => i.toString().trim())
      .filter(Boolean);

    const newEnquiry = new Enquiry({
      name: name.trim(),
      phone: cleanPhone,
      interest: cleanedInterests,
      location: location?.trim() || "Unknown",
      businessId: businessId || null,
      source: businessId
        ? "Business Profile Enquiry"
        : "TopList - Get Free List Form",
      status: "pending",
    });

    await newEnquiry.save();

    return res.status(201).json({
      success: true,
      message: businessId
        ? "Thank you! The business will contact you soon."
        : "Thank you! We'll send you the list shortly.",
      enquiry: newEnquiry,
    });
  } catch (error) {
    console.error("Create Enquiry Error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

// GET ALL ENQUIRIES — Admin Only
exports.getAllEnquiry = async (req, res) => {
  try {
    const enquiries = await Enquiry.find({})
      .sort({ createdAt: -1 })
      .limit(500)
      .select(
        "name phone interest location businessId source status createdAt resolvedAt"
      );

    return res.status(200).json({
      success: true,
      count: enquiries.length,
      enquiries,
    });
  } catch (error) {
    console.error("Get Enquiries Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch enquiries",
    });
  }
};

// MARK AS RESOLVED
exports.resolveEnquiry = async (req, res) => {
  try {
    const enquiry = await Enquiry.findById(req.params.id);
    if (!enquiry)
      return res
        .status(404)
        .json({ success: false, message: "Enquiry not found" });

    if (enquiry.status === "resolved") {
      return res
        .status(400)
        .json({ success: false, message: "Already resolved" });
    }

    enquiry.status = "resolved";
    enquiry.resolvedAt = new Date();
    await enquiry.save();

    return res.status(200).json({
      success: true,
      message: "Enquiry resolved",
      enquiry,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// DELETE ENQUIRY — Admin
exports.deleteEnquiry = async (req, res) => {
  try {
    const enquiry = await Enquiry.findByIdAndDelete(req.params.id);
    if (!enquiry)
      return res.status(404).json({ success: false, message: "Not found" });

    return res.status(200).json({ success: true, message: "Deleted" });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// NEW API — Get Enquiries for a Specific Business (Owner View)
exports.getEnquiriesByBusinessId = async (req, res) => {
  try {
    const { businessId } = req.params;

    if (!businessId) {
      return res.status(400).json({
        success: false,
        message: "businessId is required",
      });
    }

    const enquiries = await Enquiry.find({ businessId })
      .sort({ createdAt: -1 })
      .select("name phone email message location interest status createdAt");

    return res.status(200).json({
      success: true,
      count: enquiries.length,
      enquiries,
    });
  } catch (error) {
    console.error("Get Business Enquiries Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch business enquiries",
    });
  }
};
