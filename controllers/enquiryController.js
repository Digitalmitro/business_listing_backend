// controllers/enquiryController.js
const Enquiry = require("../models/Enquiry");

// CREATE ENQUIRY — FROM TOPLIST SIDEBAR (Now accepts location + businessId)
exports.createEnquiry = async (req, res) => {
  try {
    const { name, phone, interest, location, businessId } = req.body;

    // Validation
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

    // Clean & validate phone
    const cleanPhone = phone.toString().replace(/\D/g, "").slice(-10);
    if (cleanPhone.length !== 10) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid 10-digit Indian mobile number.",
      });
    }

    // Clean interests
    const cleanedInterests = interest
      .map((i) => i.toString().trim())
      .filter(Boolean);

    // Create enquiry with location and businessId
    const newEnquiry = new Enquiry({
      name: name.trim(),
      phone: cleanPhone,
      interest: cleanedInterests,
      location: location?.trim() || "Unknown",
      businessId: businessId || null, // ← Now handles businessId (can be null if not provided)
      categoryId: null,
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
      message: "Server error. Please try again later.",
    });
  }
};

// GET ALL ENQUIRIES — FOR ADMIN PANEL (Now includes location, status, businessId)
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

    if (!enquiry) {
      return res.status(404).json({
        success: false,
        message: "Enquiry not found",
      });
    }

    if (enquiry.status === "resolved") {
      return res.status(400).json({
        success: false,
        message: "Enquiry already resolved",
      });
    }

    enquiry.status = "resolved";
    enquiry.resolvedAt = new Date();
    await enquiry.save();

    return res.status(200).json({
      success: true,
      message: "Enquiry marked as resolved",
      enquiry,
    });
  } catch (error) {
    console.error("Resolve Enquiry Error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

// DELETE ENQUIRY — FOR ADMIN
exports.deleteEnquiry = async (req, res) => {
  try {
    const enquiry = await Enquiry.findByIdAndDelete(req.params.id);

    if (!enquiry) {
      return res.status(404).json({
        success: false,
        message: "Enquiry not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Enquiry deleted successfully",
    });
  } catch (error) {
    console.error("Delete Enquiry Error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};
