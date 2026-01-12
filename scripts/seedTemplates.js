const mongoose = require("mongoose");
const dotenv = require("dotenv");
const path = require("path");
const EmailTemplate = require("../models/EmailTemplate");
const Admin = require("../models/Admin");

dotenv.config({ path: path.join(__dirname, "../.env") });

const templates = [
  {
    name: "Welcome Email",
    triggerType: "welcome",
    subject: "Welcome to UrbanCitations!",
    body: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
        <h2 style="color: #1976D2;">Welcome to UrbanCitations, {{full_name}}!</h2>
        <p>We are thrilled to have you on board. UrbanCitations is your one-stop solution for finding and listing local businesses.</p>
        <p>Explore our platform to find local services or list your own business to reach more customers.</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="{{frontend_url}}" style="background-color: #1976D2; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">Explore Now</a>
        </div>
        <p>If you have any questions, feel free to contact our support team.</p>
        <br>
        <p>Best Regards,<br>The UrbanCitations Team</p>
      </div>
    `,
  },
  {
    name: "Package Purchase Confirmation",
    triggerType: "purchase",
    subject: "Package Purchase Confirmation - UrbanCitations",
    body: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
        <h2 style="color: #4CAF50;">Thank You for Your Purchase!</h2>
        <p>Hi {{full_name}},</p>
        <p>Your purchase for the business <strong>{{business_name}}</strong> was successful.</p>
        <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <p style="margin: 5px 0;"><strong>Package:</strong> {{package_name}}</p>
          <p style="margin: 5px 0;"><strong>Status:</strong> Active</p>
          <p style="margin: 5px 0;"><strong>Start Date:</strong> {{start_date}}</p>
        </div>
        <p>Your business will now benefit from the premium features included in the {{package_name}} plan.</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="{{frontend_url}}/dashboard" style="background-color: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">Go to Dashboard</a>
        </div>
        <p>If you have any questions regarding your subscription, please reach out to us.</p>
        <br>
        <p>Best Regards,<br>The UrbanCitations Team</p>
      </div>
    `,
  },
  {
    name: "Business Claim Approved",
    triggerType: "claim_approved",
    subject: "Business Claim Approved - UrbanCitations",
    body: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
        <h2 style="color: #4CAF50;">Claim Approved</h2>
        <p>Hi {{full_name}},</p>
        <p>Your request to claim the business <strong>{{business_name}}</strong> has been <strong>approved</strong> by our team.</p>
        <p>You now have full access to manage this business listing from your dashboard.</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="{{frontend_url}}/dashboard" style="background-color: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">Go to Dashboard</a>
        </div>
        <p>If you have any questions, feel free to contact us.</p>
        <br>
        <p>Best Regards,<br>The UrbanCitations Team</p>
      </div>
    `,
  },
  {
    name: "Business Claim Rejected",
    triggerType: "claim_rejected",
    subject: "Business Claim Rejected - UrbanCitations",
    body: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
        <h2 style="color: #F44336;">Claim Rejected</h2>
        <p>Hi {{full_name}},</p>
        <p>Your request to claim the business <strong>{{business_name}}</strong> has been <strong>rejected</strong> by our team.</p>
        <p>Unfortunately, we could not verify your ownership of this business. If you believe this is a mistake, please reach out to our support team with additional documentation.</p>
        <p>If you have any questions, feel free to contact us.</p>
        <br>
        <p>Best Regards,<br>The UrbanCitations Team</p>
      </div>
    `,
  },
  {
    name: "KYC Verification Approved",
    triggerType: "kyc_approved",
    subject: "KYC Verification Approved - UrbanCitations",
    body: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
        <h2 style="color: #4CAF50;">KYC Verification Approved</h2>
        <p>Hi {{full_name}},</p>
        <p>The KYC verification for your business <strong>{{business_name}}</strong> has been <strong>approved</strong>.</p>
        <p>Your business is now fully verified on our platform, which builds more trust with your customers.</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="{{frontend_url}}/serviceprofile/{{business_id}}" style="background-color: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">View Profile</a>
        </div>
        <p>If you have any questions, feel free to contact us.</p>
        <br>
        <p>Best Regards,<br>The UrbanCitations Team</p>
      </div>
    `,
  },
  {
    name: "KYC Verification Rejected",
    triggerType: "kyc_rejected",
    subject: "KYC Verification Rejected - UrbanCitations",
    body: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
        <h2 style="color: #F44336;">KYC Verification Rejected</h2>
        <p>Hi {{full_name}},</p>
        <p>The KYC verification for your business <strong>{{business_name}}</strong> has been <strong>rejected</strong>.</p>
        <div style="background-color: #FFF3E0; padding: 15px; border-radius: 5px; border-left: 5px solid #FF9800; margin: 20px 0;">
          <p style="margin: 0;"><strong>Reason for Rejection:</strong> {{rejection_reason}}</p>
        </div>
        <p>Please log in to your dashboard and re-submit the required documents to complete your verification.</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="{{frontend_url}}/dashboard" style="background-color: #2196F3; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">Update KYC</a>
        </div>
        <p>If you have any questions, feel free to contact us.</p>
        <br>
        <p>Best Regards,<br>The UrbanCitations Team</p>
      </div>
    `,
  },
  {
    name: "Enquiry Received",
    triggerType: "enquiry_received",
    subject: "New Lead for Your Business - UrbanCitations",
    body: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
        <h2 style="color: #4CAF50;">New Customer Enquiry!</h2>
        <p>Hi {{owner_name}},</p>
        <p>You have received a new lead for your business <strong>{{business_name}}</strong>.</p>
        
        <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <p style="margin: 5px 0;"><strong>Name:</strong> {{customer_name}}</p>
          <p style="margin: 5px 0;"><strong>Phone:</strong> {{customer_phone}}</p>
          <p style="margin: 5px 0;"><strong>Interest:</strong> {{customer_interest}}</p>
          <p style="margin: 5px 0;"><strong>Location:</strong> {{customer_location}}</p>
        </div>
        
        <div style="text-align: center; margin: 30px 0;">
          <a href="{{frontend_url}}/dashboard" style="background-color: #2196F3; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">View Lead in Dashboard</a>
        </div>
        
        <p>Best Regards,<br>The UrbanCitations Team</p>
      </div>
    `,
  },
];

const seedTemplates = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB for seeding templates...");

    // Find an admin to associate with the templates
    const admin = await Admin.findOne();
    if (!admin) {
      console.error("No admin found. Please seed admins first.");
      process.exit(1);
    }

    for (const templateData of templates) {
      const existing = await EmailTemplate.findOne({ triggerType: templateData.triggerType });
      if (existing) {
        console.log(`Template for trigger '${templateData.triggerType}' already exists. Skipping.`);
        continue;
      }

      const template = new EmailTemplate({
        ...templateData,
        createdBy: admin._id,
      });

      await template.save();
      console.log(`Created template: ${templateData.name}`);
    }

    console.log("Seeding complete!");
    process.exit(0);
  } catch (error) {
    console.error("Error seeding templates:", error);
    process.exit(1);
  }
};

seedTemplates();
