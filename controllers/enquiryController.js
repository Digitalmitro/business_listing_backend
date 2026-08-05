const Enquiry = require("../models/Enquiry");
const Business = require("../models/Business");
const { notifyAdmins, createNotification } = require("../helpers/notificationHelper");
const { addJob } = require("../utils/queue");
const {
  PhoneNumberValidationError,
  normalizePhoneNumber,
} = require("../utils/phoneNumber");

// CREATE ENQUIRY
exports.createEnquiry = async (req, res) => {
  try {
    const {
      name,
      phone,
      country,
      interest,
      location,
      businessId,
      userId: providedUserId,
    } = req.body;

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

    const cleanPhone = normalizePhoneNumber(phone, { country });

    const cleanedInterests = interest
      .map((i) => i.toString().trim())
      .filter(Boolean);

    const newEnquiry = new Enquiry({
      name: name.trim(),
      phone: cleanPhone,
      interest: cleanedInterests,
      location: location?.trim() || "Unknown",
      businessId: businessId || null,
      userId: providedUserId || null,
      source: businessId
        ? "Business Profile Enquiry"
        : "TopList - Get Free List Form",
      status: "pending",
    });

    await newEnquiry.save();

    // 1. Notify Admins
    await notifyAdmins({
      title: "New Enquiry Received",
      description: `${name} has submitted a new enquiry regarding ${cleanedInterests.join(", ")}.`,
      link: "/enquiry",
      category: "enquiry",
    });

    // 2. Notify Business Owner (if applicable)
    if (businessId) {
      const business = await Business.findById(businessId);
      if (business && business.userId) {
        await createNotification({
          recipientId: business.userId,
          recipientType: "User",
          title: "New Enquiry for Your Business",
          description: `You have received a new enquiry from ${name} for ${business.businessName}.`,
          link: `/business-enquiries/${businessId}`, // Assuming dashboard path
        });

        // 3. Queue Email to Business Owner
        await addJob("enquiry-email", {
          enquiry: {
            name: newEnquiry.name,
            phone: newEnquiry.phone,
            interest: newEnquiry.interest,
            location: newEnquiry.location,
          },
          businessId: business._id,
        });
      }
    }

    return res.status(201).json({
      success: true,
      message: businessId
        ? "Thank you! The business will contact you soon."
        : "Thank you! We'll send you the list shortly.",
      enquiry: newEnquiry,
    });
  } catch (error) {
    if (error instanceof PhoneNumberValidationError) {
      return res.status(400).json({
        success: false,
        message: error.message,
        code: error.code,
      });
    }
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
      .populate("businessId", "businessName")
      .populate("userId", "country")
      .select(
        "name phone interest location businessId source status createdAt resolvedAt userId"
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

    // 3. Notify User who submitted the enquiry (if they are registered)
    if (enquiry.userId) {
      await createNotification({
        recipientId: enquiry.userId,
        recipientType: "User",
        title: "Enquiry Resolved",
        description: `Your enquiry regarding ${enquiry.interest.join(", ")} has been marked as resolved.`,
        link: "/user/enquiries", // Assuming user dashboard path
      });
    }

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
      .populate("userId", "country")
      .select("name phone email message location interest status createdAt userId");

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
