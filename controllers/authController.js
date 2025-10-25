const bcrypt = require("bcryptjs");
const User = require("../models/User.js");
const sendMail = require("../services/sendMail.js");
const { OAuth2Client } = require("google-auth-library");
const jwt = require("jsonwebtoken");
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const moment = require("moment");
const { default: axios } = require("axios");
const momentTz = require('moment-timezone');

function generateOTPWithExpiration() {
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiration = moment().add(2, "minutes").toISOString();
  return { otp, expiration };
}

exports.register = async (req, res) => {
  try {
    const { full_name, email, password, phone, isAgree, timeZone, country } = req.body;
    if (!full_name || !email || !password || !isAgree) {
      return res.status(400).json({ message: 'Please provide full name, email, password, and agree to terms' });
    }
    if (phone && !/^\+?[1-9]\d{1,14}$/.test(phone)) {
      return res.status(400).json({ message: 'Invalid phone number format' });
    }
    if (timeZone && !momentTz.tz.names().includes(timeZone)) {
      return res.status(400).json({ message: 'Invalid time zone' });
    }
    if (country && !/^[A-Za-z\s]{1,100}$/.test(country)) {
      return res.status(400).json({ message: 'Invalid country name' });
    }
    const existingUser = await mongoose.model('User').findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'Email is already registered' });
    }
    const user = new (mongoose.model('User'))({
      full_name,
      email,
      password,
      phone,
      isAgree,
      subscribedToEmails: true,
      timeZone: timeZone || 'UTC',
      country: country || 'Unknown',
    });
    await user.save();
    res.status(201).json({ message: 'User registered successfully' });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ message: 'Invalid data provided' });
    }
    res.status(500).json({ message: 'Internal server error' });
  }
};

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res
        .status(400)
        .json({ message: "Please provide both email and password" });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ message: "Invalid email or password" });
    }
    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      return res.status(401).json({ message: "Invalid email or password" });
    }
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
      expiresIn: "1d",
    });
    res.status(200).json({ message: "Login successful", token });
  } catch (error) {
    res.status(500).json({ message: "An error occurred during login" });
  }
};

exports.forgotPassword = async (req, res) => {
  try {
    const { email, otp, password } = req.body;

    if (!email || !otp || !password) {
      return res
        .status(400)
        .json({ message: "Please provide email, OTP, and new password" });
    }

    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({ message: "Email does not exist" });
    }

    if (user.otp === otp && moment().isBefore(moment(user.otpExpiration))) {
      // Hash the new password
      const hashedPassword = await bcrypt.hash(password, 10);

      // Update password
      user.password = hashedPassword;
      user.otp = undefined;
      user.otpExpiration = undefined;

      await user.save();

      res.status(200).json({ message: "Password updated successfully" });
    } else {
      res.status(400).json({ message: "Invalid or expired OTP" });
    }
  } catch (error) {
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.sendOTP = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ message: "Please provide an email" });
    }
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: "Email does not exist" });
    }
    if (user.otp && moment().isBefore(moment(user.otpExpiration))) {
      return res.status(400).json({ message: "OTP not expired yet" });
    }
    const { otp, expiration } = generateOTPWithExpiration();
    const emailSubject = `Your OTP for Verification`;
    const emailBody = `Your 6-digit OTP is: ${otp}`;
    await sendMail(email, emailSubject, emailBody);
    user.otp = otp;
    user.otpExpiration = expiration;
    await user.save();

    res.status(200).json({ message: "OTP sent successfully", otp });
  } catch (error) {
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.googleLogin = async (req, res) => {
  try {
    const { tokenId } = req.body;
    // Verify Google ID Token
    const ticket = await client.verifyIdToken({
      idToken: tokenId,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const { email, name, picture } = ticket.getPayload();

    if (!email || !name) {
      return res.status(400).json({ message: "Invalid Google token" });
    }

    // Check if the user exists
    let user = await User.findOne({ email });

    if (!user) {
      // Create new user if not exists
      user = new User({
        full_name: name,
        email,
        password: "", // No password for SSO users
        userImage: picture,
      });
      await user.save();
    }

    // Generate JWT token
    const payload = { id: user._id };
    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    res.status(200).json({
      message: "Login successful",
      token,
    });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Google login failed", error: error.message });
  }
};

exports.getUserProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    if (!userId)
      return res.status(401).json({ message: "provide corrct token" });
    const user = await User.findById(userId).select("-password");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    res.status(200).json(user);
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.updateUserProfile = async (req, res) => {
  const userId = req.user.id;
  // let iconUrl;
  try {
    const updates = req.body;

    if (req.files.image) {
      // iconUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
      const iconUpload = req.files.image[0];
      updates.userImage = iconUpload.location;
    }
    const updatedUser = await User.findByIdAndUpdate(userId, updates, {
      new: true,
      runValidators: true,
    });

    if (!updatedUser) {
      return res.status(404).json({ message: "User not found" });
    }

    res.status(200).json({
      message: "Profile updated successfully",
      user: updatedUser,
    });
  } catch (error) {
    res.status(500).json({
      message: "An error occurred while updating the profile",
      error: error.message,
    });
  }
};
//use for admin
exports.getAllUsers = async (req, res) => {
  try {
    const { search = "", page = 1, limit = 10, country } = req.query;
    const pageNumber = parseInt(page, 10);
    const pageLimit = parseInt(limit, 10);
    const skip = (pageNumber - 1) * pageLimit;
    const searchQuery = {
      $or: [
        { email: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
      ],
    };
    if (country) {
      searchQuery.country = country;
    }
    const users = await User.find(searchQuery).skip(skip).limit(pageLimit);
    const totalUsers = await User.countDocuments(searchQuery);

    res.json({
      users,
      totalUsers,
    });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

// delete by id
exports.deleteById = async (req, res) => {
  try {
    const { id } = req.params;

    // Find and delete user in one step
    const deletedUser = await User.findByIdAndDelete(id);

    if (!deletedUser) {
      return res.status(404).json({ message: "User not found" });
    }

    res.status(200).json({ message: "User deleted successfully", deletedUser });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
    console.log(error);
  }
};

exports.fetchUserLocation = async (req, res) => {
  const { lat, lon } = req.query;
  try {
    const response = await axios.get(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`,
    );

    return res.status(200).json(response.data);
  } catch (error) {
    console.error("Reverse geocoding error:", error.message);
    res.status(500).json({ error: "Failed to reverse geocode" });
  }
};

exports.fetchCoordinates = async (req, res) => {
  try {
    const { address } = req.body;

    if (!address) {
      return res.status(400).json({ message: 'Address is required' });
    }

    console.log(address)

    const response = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: {
        q: address.split(' ')[0],
        format: 'json',
        addressdetails: 1,
        limit: 1
      },
    });

    if (response.data.length === 0) {
      return res.status(404).json({ message: 'Address not found' });
    }

    const result = response.data[0];
    const { lat, lon, display_name, address: addressDetails } = result;

    res.json({
      latitude: parseFloat(lat),
      longitude: parseFloat(lon),
      displayName: display_name,
      addressDetails
    });
  } catch (error) {
    console.error('Geocoding error:', error);
    res.status(500).json({ message: 'Geocoding service unavailable' });
  }
};
