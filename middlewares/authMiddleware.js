// backend/middlewares/authMiddleware.js
const jwt = require("jsonwebtoken");
const Admin = require("../models/Admin");
const User = require("../models/User");

const authMiddleware = async (req, res, next) => {
  try {
    const token = req.header("Authorization")?.replace("Bearer ", "");

    if (!token) {
      return res.status(401).json({ success: false, message: "No token, authorization denied" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // YE LINE ADD KAR DE — FULL USER FETCH KAREGA DB SE
    const user = await User.findById(decoded.id).select("-password");
    const admin = await Admin.findById(decoded.id).select("-password");
    
    if (!user && !admin) {
      return res.status(401).json({ success: false, message: "User not found" });
    }


    req.user = user || admin; // ← AB FULL USER AAYEGA (full_name, email sab)
    next();
  } catch (error) {
    console.error("Auth Middleware Error:", error);
    res.status(401).json({ success: false, message: "Token is not valid" });
  }
};

module.exports = { authMiddleware };