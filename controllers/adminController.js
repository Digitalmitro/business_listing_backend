const Admin = require('../models/Admin');
const jwt = require('jsonwebtoken');
const User = require('../models/User')
const otpGenerator = require("otp-generator");
const bcrypt = require("bcryptjs");
const sendMail = require("../services/sendMail");

const OTP_EXPIRATION_TIME = 5 * 60 * 1000;
// Admin login
exports.login = async (req, res) => {
  const { email, password } = req.body;

  try {
    // Find admin by email
    const admin = await Admin.findOne({ email });
    if (!admin) {
      return res.status(400).json({ success: false, message: "Invalid credentials" });
    }

    // Compare provided password with stored hash
    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: "Invalid credentials" });
    }

    // Generate 6-digit OTP
    const otp = otpGenerator.generate(6, { upperCase: false, specialChars: false });
    const otpExpiration = new Date(Date.now() + OTP_EXPIRATION_TIME);

    // Store OTP & expiration in the database
    admin.otp = otp;
    admin.otpExpiration = otpExpiration;
    await admin.save();

    // Send OTP email
    const emailBody = `Your OTP for login is: ${otp}\n\nThis OTP is valid for 5 minutes.`;
    const mailSent = await sendMail(admin.email, "Your OTP for Admin Login", emailBody);

    if (mailSent) {
      return res.status(200).json({
        success: true,
        message: "OTP sent to email. Please check your email to complete login.",
      });
    } else {
      return res.status(500).json({ success: false, message: "Failed to send OTP email" });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};
exports.register = async (req,res) =>{
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }
    const existingAdmin = await Admin.findOne({ email });
    if (existingAdmin) {
      return res.status(400).json({ error: 'Email is already in use.' });
    }
    const newAdmin = new Admin({ email, password });
    await newAdmin.save();

    res.status(201).json({
      message: 'Admin created successfully.',
    });
  } catch (error) {
    console.error('Error creating admin:', error);
    res.status(500).json({ error: 'Internal server error.' });
  }
}

exports.getAlluserAndseller = async (req,res) =>{
 try {
   const adminId = req.user.id
   if (!adminId) {
    return res.status(400).json({ success: false, message: "Admin ID is required." });
  }

  const totalUsers = await User.countDocuments();
  const totalSellers = await User.countDocuments({ isSeller: true });
  res.status(200).json({
    success: true,
    totalUsers, 
    sellerCount:totalSellers
    // users: allUsers
  });
  
 } catch (error) {
  res.status(500).json({ success: false, message: error.message });
 }
}

// Admin Login - Step 2: Verify OTP & Generate Token
exports.verifyOtp = async (req, res) => {
  const { email, otp } = req.body;

  try {
    const admin = await Admin.findOne({ email });

    if (!admin) {
      return res.status(400).json({ success: false, message: "Invalid credentials" });
    }

    const currentTime = new Date();

    // Check if OTP is valid and not expired
    if (admin.otp === otp && currentTime < admin.otpExpiration) {
      const token = await admin.generateAuthToken(); // Generate JWT token

      // Clear OTP fields after successful verification
      admin.otp = null;
      admin.otpExpiration = null;
      await admin.save();

      return res.status(200).json({
        success: true,
        message: "OTP verified successfully, login complete.",
        token,
      });
    } else {
      return res.status(400).json({ success: false, message: "Invalid or expired OTP" });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};