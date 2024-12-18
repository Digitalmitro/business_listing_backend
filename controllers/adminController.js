const Admin = require('../models/Admin');
const jwt = require('jsonwebtoken');
const User = require('../models/User')
// Admin login
exports.login = async (req, res) => {
  const { email, password } = req.body;
//  console.log(email, password)
  try {
    // Find admin by email
    const admin = await Admin.findOne({ email });
    if (!admin) {
      return res.status(400).json({ success: false, message: 'Invalid credentials' });
    }

    // Compare provided password with stored hash
    const isMatch = await admin.comparePassword(password);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Invalid credentials' });
    }

    // Generate JWT token
    const token = admin.generateAuthToken();

    res.status(200).json({
      success: true,
      message: 'Login successful',
      token,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
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