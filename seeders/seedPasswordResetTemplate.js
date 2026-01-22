const mongoose = require("mongoose");
const EmailTemplate = require("../models/EmailTemplate");
const Admin = require("../models/Admin");
require("dotenv").config();

const passwordResetTemplate = {
  name: "Password Reset OTP",
  triggerType: "password_reset",
  subject: "Reset Your Password - Urban Citations",
  body: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset Your Password</title>
</head>
<body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f4f4f4;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f4f4; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #1976d2 0%, #115293 100%); padding: 40px 30px; text-align: center;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: bold;">Reset Your Password</h1>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 40px 30px;">
              <p style="margin: 0 0 20px; color: #333333; font-size: 16px; line-height: 1.6;">
                Hello <strong>{{userName}}</strong>,
              </p>
              
              <p style="margin: 0 0 20px; color: #666666; font-size: 15px; line-height: 1.6;">
                We received a request to reset the password for your Urban Citations account. Use the OTP below to complete the password reset process:
              </p>
              
              <!-- OTP Box -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin: 30px 0;">
                <tr>
                  <td align="center">
                    <div style="background-color: #f8f9fa; border: 2px dashed #1976d2; border-radius: 8px; padding: 20px; display: inline-block;">
                      <p style="margin: 0 0 10px; color: #666666; font-size: 14px;">Your OTP is:</p>
                      <h2 style="margin: 0; color: #1976d2; font-size: 36px; font-weight: bold; letter-spacing: 8px;">{{otp}}</h2>
                      <p style="margin: 10px 0 0; color: #999999; font-size: 12px;">Valid for 10 minutes</p>
                    </div>
                  </td>
                </tr>
              </table>
              
              <p style="margin: 20px 0; color: #666666; font-size: 15px; line-height: 1.6;">
                If you didn't request this password reset, please ignore this email or contact our support team if you have concerns.
              </p>
              
              <!-- Security Notice -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin: 30px 0; background-color: #fff3cd; border-left: 4px solid #ffc107; border-radius: 4px;">
                <tr>
                  <td style="padding: 15px;">
                    <p style="margin: 0; color: #856404; font-size: 13px;">
                      <strong>Security Tip:</strong> Never share your OTP with anyone. Urban Citations will never ask for your password or OTP via email or phone.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="background-color: #f8f9fa; padding: 30px; text-align: center; border-top: 1px solid #eeeeee;">
              <p style="margin: 0 0 10px; color: #666666; font-size: 14px;">
                Need help? Contact us at 
                <a href="mailto:support@urbancitations.com" style="color: #1976d2; text-decoration: none;">support@urbancitations.com</a>
              </p>
              <p style="margin: 0; color: #999999; font-size: 12px;">
                © 2024 Urban Citations. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `,
  placeholders: ["userName", "otp"],
  isActive: true,
};

const seedPasswordResetTemplate = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB");

    // Find super-admin
    const superAdmin = await Admin.findOne({ role: 'super-admin' });
    if (!superAdmin) {
      console.error("❌ No super-admin found. Please create a super-admin first.");
      await mongoose.disconnect();
      process.exit(1);
    }

    // Check if template already exists
    const existing = await EmailTemplate.findOne({ triggerType: "password_reset" });
    
    if (existing) {
      console.log("Password reset template already exists. Updating...");
      await EmailTemplate.findOneAndUpdate(
        { triggerType: "password_reset" },
        { ...passwordResetTemplate, createdBy: superAdmin._id },
        { new: true }
      );
      console.log("✅ Password reset template updated successfully!");
    } else {
      await EmailTemplate.create({
        ...passwordResetTemplate,
        createdBy: superAdmin._id
      });
      console.log("✅ Password reset template created successfully!");
    }

    await mongoose.disconnect();
    console.log("Disconnected from MongoDB");
  } catch (error) {
    console.error("❌ Error seeding password reset template:", error);
    process.exit(1);
  }
};

seedPasswordResetTemplate();
