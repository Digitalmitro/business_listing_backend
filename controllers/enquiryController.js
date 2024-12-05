const Enquiry = require("../models/Enquiry"); 
const Business = require("../models/Business"); 

exports.createEnquiry = async (req, res) => {
  try {
    const { businessId, categoryId, interest, name, phone } = req.body;
    if (!businessId || !categoryId || !interest || !name || !phone) {
      return res.status(400).json({ message: "All fields are required." });
    }

    const newEnquiry = new Enquiry({
      businessId,
      categoryId,
      interest,
      name,
      phone,
    });

    await newEnquiry.save();
    const business = await Business.findByIdAndUpdate(
      businessId,
      { $inc: { enquiryCount: 1 } },
      { new: true }
    );

    if (!business) {
      return res.status(404).json({ message: "Business not found." });
    }

    res.status(201).json({
      message: "Enquiry created successfully.",
      enquiry: newEnquiry,
    });
  } catch (error) {
    console.error("Error creating enquiry:", error);
    res.status(500).json({ error: error.message });
  }
};
