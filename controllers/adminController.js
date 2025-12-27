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
exports.register = async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Name, email and password are required.' });
    }
    const existingAdmin = await Admin.findOne({ email });
    if (existingAdmin) {
      return res.status(400).json({ error: 'Email is already in use.' });
    }
    // First registered admin should ideally be super-admin or managed via DB seed
    const newAdmin = new Admin({ name, email, password, role: 'super-admin' });
    await newAdmin.save();

    res.status(201).json({
      message: 'Super Admin created successfully.',
    });
  } catch (error) {
    console.error('Error creating admin:', error);
    res.status(500).json({ error: 'Internal server error.' });
  }
}

// Create Sub-Admin (Only by Super-Admin)
exports.createSubAdmin = async (req, res) => {
  try {
    const { name, email, password, permissions } = req.body;
    
    if (req.user.role !== 'super-admin') {
      return res.status(403).json({ success: false, message: "Only super-admin can create admins" });
    }

    const existingAdmin = await Admin.findOne({ email });
    if (existingAdmin) {
      return res.status(400).json({ success: false, message: "Admin with this email already exists" });
    }

    const newAdmin = new Admin({
      name,
      email,
      password,
      role: 'admin',
      permissions: permissions || []
    });

    await newAdmin.save();
    res.status(201).json({ success: true, message: "Admin created successfully", admin: newAdmin });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Get All Admins (Only by Super-Admin)
exports.getAllAdmins = async (req, res) => {
  try {
    if (req.user.role !== 'super-admin') {
      return res.status(403).json({ success: false, message: "Access denied" });
    }
    const admins = await Admin.find({ role: 'admin' }).select('-password');
    res.status(200).json({ success: true, admins });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Update Admin (Only by Super-Admin)
exports.updateSubAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, permissions, password } = req.body;

    if (req.user.role !== 'super-admin') {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const admin = await Admin.findById(id);
    if (!admin) return res.status(404).json({ success: false, message: "Admin not found" });

    if (name) admin.name = name;
    if (email) admin.email = email;
    if (permissions) admin.permissions = permissions;
    if (password) admin.password = password; // Pre-save hook will hash it

    await admin.save();
    res.status(200).json({ success: true, message: "Admin updated successfully", admin });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Delete Admin (Only by Super-Admin)
exports.deleteSubAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    if (req.user.role !== 'super-admin') {
      return res.status(403).json({ success: false, message: "Access denied" });
    }
    await Admin.findByIdAndDelete(id);
    res.status(200).json({ success: true, message: "Admin deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Get current admin profile & permissions
exports.getAdminProfile = async (req, res) => {
  try {
    const admin = await Admin.findById(req.user.id).select('-password');
    if (!admin) return res.status(404).json({ success: false, message: "Admin not found" });
    res.status(200).json({ success: true, admin });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

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
        admin: {
          id: admin._id,
          name: admin.name,
          email: admin.email,
          role: admin.role,
          permissions: admin.permissions
        }
      });
    } else {
      return res.status(400).json({ success: false, message: "Invalid or expired OTP" });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// Forgot Password - Step 1: Send OTP
exports.forgotPassword = async (req, res) => {
  const { email } = req.body;
  try {
    const admin = await Admin.findOne({ email });
    if (!admin) {
      return res.status(404).json({ success: false, message: "Admin not found" });
    }

    const otp = otpGenerator.generate(6, { upperCase: false, specialChars: false });
    const otpExpiration = new Date(Date.now() + OTP_EXPIRATION_TIME);

    admin.otp = otp;
    admin.otpExpiration = otpExpiration;
    await admin.save();

    const emailBody = `Your OTP for password reset is: ${otp}\n\nThis OTP is valid for 5 minutes.`;
    const mailSent = await sendMail(admin.email, "Password Reset OTP - Admin", emailBody);

    if (mailSent) {
      res.status(200).json({ success: true, message: "OTP sent to email" });
    } else {
      res.status(500).json({ success: false, message: "Failed to send email" });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// Forgot Password - Step 2: Reset Password
exports.resetPassword = async (req, res) => {
  const { email, otp, newPassword } = req.body;
  try {
    const admin = await Admin.findOne({ email });
    if (!admin) {
      return res.status(404).json({ success: false, message: "Admin not found" });
    }

    const currentTime = new Date();
    if (admin.otp === otp && currentTime < admin.otpExpiration) {
      admin.password = newPassword; // Pre-save hook will hash it
      admin.otp = null;
      admin.otpExpiration = null;
      await admin.save();

      res.status(200).json({ success: true, message: "Password reset successfully" });
    } else {
      res.status(400).json({ success: false, message: "Invalid or expired OTP" });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// Update Own Profile
exports.updateProfile = async (req, res) => {
  try {
    const adminId = req.user.id;
    const { name, email, password } = req.body;

    const admin = await Admin.findById(adminId);
    if (!admin) return res.status(404).json({ success: false, message: "Admin not found" });

    if (name) admin.name = name;
    if (email) {
      const existing = await Admin.findOne({ email, _id: { $ne: adminId } });
      if (existing) return res.status(400).json({ success: false, message: "Email already in use" });
      admin.email = email;
    }
    if (password) admin.password = password; // Pre-save hook will hash it

    await admin.save();
    res.status(200).json({ 
      success: true, 
      message: "Profile updated successfully",
      admin: {
        id: admin._id,
        name: admin.name,
        email: admin.email,
        role: admin.role,
        permissions: admin.permissions
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};