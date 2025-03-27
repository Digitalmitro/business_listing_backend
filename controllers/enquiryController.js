const Enquiry = require("../models/Enquiry"); 
const Business = require("../models/Business"); 
const sendMail = require("../services/sendMail")

exports.createEnquiry = async (req, res) => {
  try {
    const { businessId, categoryId, interest, name, phone } = req.body;
    if ( !categoryId || !interest || !name || !phone) {
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

exports.getAllEnquiry = async(req,res) =>{
  try {
    const enquiry = await Enquiry.find({}).populate('businessId categoryId','businessName name');
    return res.status(200).json(enquiry)
  } catch (error) {
    return res.status(500).json({ message: "Server error", details: error.message })
  }
}

exports.resloveEnquiry  = async (req,res) =>{
  try {
    const enquiry = await Enquiry.findById(req.params.id).populate("businessId");

    if (!enquiry) {
      return res.status(404).json({ message: "Inquiry not found" });
    }

    if (enquiry.status === "resolved") {
      return res.status(400).json({ message: "Inquiry is already resolved" });
    }

    // Mark inquiry as resolved
    enquiry.status = "resolved";
    await enquiry.save();

    // Get Business Owner's Email
    const business = enquiry.businessId;
    if (business?.contact?.email?.length > 0) {
      const businessEmail = business.contact.email[0];

      // Send email to business owner
      await sendMail(
        businessEmail,
        "New Inquiry Received",
        `
        Dear ${business?.contact?.customerName || "Business Owner"},
        
        You have received a new inquiry from a potential customer.
        
        **Customer Details:**
        - **Name:** ${enquiry.name}
        - **Phone:** ${enquiry.phone}
        - **Interests:** ${enquiry.interest.join(", ")}

        Please follow up with the customer as soon as possible.
        
        Regards,  
        Your Team
        `
      );
    }

    res.json({ message: "Inquiry resolved and email sent successfully" });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
}
