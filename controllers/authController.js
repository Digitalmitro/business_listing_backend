const bcrypt = require('bcryptjs');
const User = require('../models/User.js');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

exports.register = async (req, res) => {
  try {
    const { name, email, password ,isAgree} = req.body;
    if (!name || !email || !password ) {
      return res.status(400).json({ message: "Please provide full name, email, and password" });
    }
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: "Email is already registered" });
    }
    const user = new User({ "full_name": name, email, password,isAgree });
    await user.save();

    res.status(201).json({ message: "User registered successfully" });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ message: "Invalid data provided" });
    }
    res.status(500).json({ message: "internal server error" });
  }
};

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: "Please provide both email and password" });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ message: "Invalid email or password" });
    }
    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      return res.status(401).json({ message: "Invalid email or password" });
    }
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1d' });
    res.status(200).json({ message: "Login successful", token });
  } catch (error) {

    res.status(500).json({ message: "An error occurred during login" });
  }
};

exports.forgotPassword = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Check if email and password are provided
    if (!email || !password) {
      return res.status(400).json({ message: "Please provide both email and new password" });
    }

    // Find the user by email
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: "Email does not exist" });
    }

    // Hash the new password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Update the user's password
    user.password = hashedPassword;
    await user.save();

    res.status(200).json({ message: "Password updated successfully" });
  } catch (error) {
    res.status(500).json({ message: "internal server error" });
  }
};

exports.googleLogin = async (req, res) => {
  try {
    const { tokenId } = req.body;
    // Verify Google ID Token
    const ticket = await client.verifyIdToken({
      idToken: tokenId,
      audience: process.env.GOOGLE_CLIENT_ID
    });

    const { email, name, picture } = ticket.getPayload();

    if (!email || !name) {
      return res.status(400).json({ message: 'Invalid Google token' });
    }

    // Check if the user exists
    let user = await User.findOne({ email });

    if (!user) {
      // Create new user if not exists
      user = new User({
        full_name: name,
        email,
        password: '', // No password for SSO users
        userImage: picture
      });
      await user.save();
    }

    // Generate JWT token
    const payload = { id: user._id};
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.status(200).json({
      message: 'Login successful',
      token
    });
  } catch (error) {
    res.status(500).json({ message: 'Google login failed', error: error.message });
  }
};

exports.getUserProfile = async (req,res) =>{
  try {
    const userId = req.user.id;
    if(!userId) return res.status(401).json({"message": "provide corrct token"})
    const user = await User.findById(userId).select('-password');
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    res.status(200).json(user);
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
}

exports.updateUserProfile = async (req,res) =>{
  const userId = req.user.id; 
  const updates = req.body;
  let iconUrl;
  try {
      if (req.file) {
          iconUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
          updates.userImage = iconUrl; 
      }
      const updatedUser = await User.findByIdAndUpdate(userId, updates, {
          new: true, 
          runValidators: true, 
      })

      if (!updatedUser) {
          return res.status(404).json({ message: 'User not found' });
      }

      res.status(200).json({
          message: 'Profile updated successfully',
          user: updatedUser,
      });
  } catch (error) {
      res.status(500).json({
          message: 'An error occurred while updating the profile',
          error: error.message,
      });
  }
}
//use for admin
exports.getAllUsers  = async( req, res) =>{
  try {
    const { search = '', page = 1, limit = 10 } = req.query;
    const pageNumber = parseInt(page, 10);
    const pageLimit = parseInt(limit, 10);
    const skip = (pageNumber - 1) * pageLimit;
    const searchQuery = {
        $or: [
            { email: { $regex: search, $options: 'i' } },
            { phone: { $regex: search, $options: 'i' } }
        ]
    };
    const users = await User.find(searchQuery)
        .skip(skip)
        .limit(pageLimit);
    const totalUsers = await User.countDocuments(searchQuery);

    res.json({
        users,
        totalUsers
    });

} catch (error) {
  console.log(error)
    res.status(500).json({ message: 'Server error' });
}
}



