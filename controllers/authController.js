const bcrypt = require("bcryptjs");
const User = require("../models/User.js");
const Tenant = require("../models/Tenant.js");
const sendMail = require("../services/sendMail.js");
const { OAuth2Client } = require("google-auth-library");
const jwt = require("jsonwebtoken");
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const moment = require("moment");
const { default: axios } = require("axios");
const momentTz = require("moment-timezone");
const { default: mongoose } = require("mongoose");
const ExcelJS = require("exceljs");
const Business = require("../models/Business");
const { addJob } = require("../utils/queue");
const geocodingService = require("../services/geocodingService");
const { getTemplate } = require("../helpers/emailHelper");
const validator = require("validator");
const crypto = require("crypto");
const { searchPattern, exactInsensitive } = require("../utils/regex");

const OTP_TTL_MINUTES = 10; // matches the "expires in 10 minutes" wording of the email
const MAX_OTP_ATTEMPTS = 5;
const OTP_SENT_MESSAGE = "If an account exists for this email, an OTP has been sent to it.";

function generateOTPWithExpiration() {
  const otp = crypto.randomInt(100000, 1000000).toString();
  const expiration = moment().add(OTP_TTL_MINUTES, "minutes").toISOString();
  return { otp, expiration };
}

/** Emails must have a domain with a TLD (rejects "x@localhost"). */
function isValidEmail(email) {
  return typeof email === "string" && validator.isEmail(email.trim(), { require_tld: true });
}

/** Minimum password policy: 8+ characters with at least one letter and one number. */
function passwordPolicyError(password) {
  if (typeof password !== "string" || password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return "Password must be at least 8 characters and contain letters and numbers.";
  }
  if (password.length > 128) return "Password must be at most 128 characters.";
  return null;
}

// Fields a user may change on their own profile. Everything else (tenantId, isSeller,
// businesses, password, otp, subscription flags...) is server-managed.
const EDITABLE_PROFILE_FIELDS = [
  "full_name", "email", "phone", "dob", "maritalStatus", "city", "area",
  "pincode", "occupation", "timeZone", "country",
];

function toPublicUser(user) {
  const plain = typeof user?.toObject === "function" ? user.toObject() : { ...user };
  delete plain.password;
  delete plain.otp;
  delete plain.otpExpiration;
  delete plain.otpAttempts;
  return plain;
}

exports.register = async (req, res) => {
  try {
    const { full_name, email, password, phone, isAgree, timeZone, country } =
      req.body;
    if (!full_name || !email || !password || !isAgree) {
      return res.status(400).json({
        message:
          "Please provide full name, email, password, and agree to terms",
      });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ message: "Please provide a valid email address" });
    }
    const weakPassword = passwordPolicyError(password);
    if (weakPassword) {
      return res.status(400).json({ message: weakPassword });
    }
    if (phone && !/^\+?[1-9]\d{1,14}$/.test(phone)) {
      return res.status(400).json({ message: "Invalid phone number format" });
    }
    if (timeZone && !momentTz.tz.names().includes(timeZone)) {
      return res.status(400).json({ message: "Invalid time zone" });
    }
    if (country && !/^[A-Za-z\s]{1,100}$/.test(country)) {
      return res.status(400).json({ message: "Invalid country name" });
    }
    const existingUser = await mongoose.model("User").findOne({ email: String(email).trim().toLowerCase() });
    if (existingUser) {
      return res.status(400).json({ message: "Email is already registered" });
    }
    const user = new (mongoose.model("User"))({
      full_name,
      email,
      password,
      phone,
      isAgree,
      subscribedToEmails: true,
      timeZone: timeZone || "UTC",
      country: country || "Unknown",
    });
    await user.save();
    const tenant = await Tenant.create({ ownerUserId: user._id, name: full_name });
    user.tenantId = tenant._id;
    await user.save();

    // Add welcome email job to queue
    await addJob("welcome-email", { userId: user._id });

    res.status(201).json({ message: "User registered successfully" });
  } catch (error) {
    if (error.name === "ValidationError") {
      return res.status(400).json({ message: "Invalid data provided" });
    }
    console.log(error);
    res.status(500).json({ message: "Internal server error" });
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
    const token = jwt.sign({ id: user._id, tenantId: user.tenantId }, process.env.JWT_SECRET, {
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
      return res.status(400).json({ 
        message: "Please provide email, OTP, and new password" 
      });
    }

    const weakPassword = passwordPolicyError(password);
    if (weakPassword) {
      return res.status(400).json({ message: weakPassword });
    }

    const user = await User.findOne({ email: String(email).trim().toLowerCase() });

    // Unknown email, missing/expired OTP and wrong OTP all get the same answer.
    if (!user || !user.otp || !user.otpExpiration || moment().isAfter(moment(user.otpExpiration))) {
      return res.status(400).json({ message: "Invalid or expired OTP" });
    }

    if (String(user.otp) !== String(otp)) {
      const attempts = (user.otpAttempts || 0) + 1;
      // Too many wrong guesses burn the OTP; the user has to request a new one.
      const update = attempts >= MAX_OTP_ATTEMPTS
        ? { $unset: { otp: "", otpExpiration: "", otpAttempts: "" } }
        : { $set: { otpAttempts: attempts } };
      await User.updateOne({ _id: user._id }, update);
      return res.status(400).json({ message: "Invalid or expired OTP" });
    }

    // CRITICAL FIX: Use updateOne to bypass pre-save hook
    const hashedPassword = await bcrypt.hash(password, 12); // Match model rounds

    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          password: hashedPassword,
        },
        $unset: {
          otp: "",
          otpExpiration: "",
          otpAttempts: "",
        },
      }
    );

    return res.status(200).json({ 
      success: true,
      message: "Password reset successfully! You can now login." 
    });
  } catch (error) {
    console.error("Forgot Password Error:", error);
    return res.status(500).json({ 
      message: "Server error. Please try again." 
    });
  }
};

exports.sendOTP = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ message: "Please provide an email" });
    }
    // The same response whether or not the account exists (no account enumeration),
    // and the OTP itself only ever travels by email.
    const user = await User.findOne({ email: String(email).trim().toLowerCase() });
    if (!user) {
      return res.status(200).json({ message: OTP_SENT_MESSAGE });
    }
    if (user.otp && moment().isBefore(moment(user.otpExpiration).subtract(OTP_TTL_MINUTES - 1, "minutes"))) {
      // An OTP was sent less than a minute ago; don't send another one yet.
      return res.status(200).json({ message: OTP_SENT_MESSAGE });
    }
    const { otp, expiration } = generateOTPWithExpiration();
    
    // Use email template for professional OTP email
    const { subject, html } = await getTemplate(
      "password_reset",
      {
        "{{userName}}": user.full_name || "User",
        "{{otp}}": otp,
      },
      {
        subject: "Reset Your Password - Urban Citations",
        html: `
          <h2>Reset Your Password</h2>
          <p>Your OTP is: <strong>${otp}</strong></p>
          <p>This OTP will expire in 10 minutes.</p>
        `,
      }
    );
    
    await sendMail(email, subject, html);
    user.otp = otp;
    user.otpExpiration = expiration;
    user.otpAttempts = 0;
    await user.save();

    res.status(200).json({ message: OTP_SENT_MESSAGE });
  } catch (error) {
    console.error("Send OTP Error:", error);
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
      const tenant = await Tenant.create({ ownerUserId: user._id, name });
      user.tenantId = tenant._id;
      await user.save();

      // Add welcome email job to queue for new SSO users
      await addJob("welcome-email", { userId: user._id });
    } else if (!user.tenantId) {
      const tenant = await Tenant.create({ ownerUserId: user._id, name: user.full_name || name });
      user.tenantId = tenant._id;
      await user.save();
    }

    // Generate JWT token
    const payload = { id: user._id, tenantId: user.tenantId, role: "user" };
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
    const user = await User.findById(userId).select("-password -otp -otpExpiration -otpAttempts");
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
  try {
    const updates = {};
    const unset = {};
    for (const field of EDITABLE_PROFILE_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(req.body, field)) continue;
      let value = req.body[field];
      if (typeof value === "string") value = value.trim();
      // Optional fields cleared in the form arrive as "" (multipart) or null.
      if ((value === "" || value === null || value === "null" || value === "undefined") && field !== "full_name" && field !== "email") {
        unset[field] = "";
        continue;
      }
      if (typeof value !== "string" && typeof value !== "number") continue;
      updates[field] = value;
    }

    if (Object.prototype.hasOwnProperty.call(updates, "full_name") && !updates.full_name) {
      return res.status(400).json({ message: "Full name cannot be empty" });
    }
    if (Object.prototype.hasOwnProperty.call(updates, "email")) {
      if (!isValidEmail(updates.email)) {
        return res.status(400).json({ message: "Please provide a valid email address" });
      }
      updates.email = updates.email.toLowerCase();
      const taken = await User.exists({ email: updates.email, _id: { $ne: userId } });
      if (taken) {
        return res.status(409).json({ message: "Email is already registered" });
      }
    }
    if (updates.maritalStatus) updates.maritalStatus = String(updates.maritalStatus).toLowerCase();
    if (updates.phone && !/^\+?[0-9\s-]{6,20}$/.test(String(updates.phone))) {
      return res.status(400).json({ message: "Invalid phone number format" });
    }
    if (updates.timeZone && !momentTz.tz.names().includes(updates.timeZone)) {
      return res.status(400).json({ message: "Invalid time zone" });
    }

    if (req.files && req.files.image) {
      const iconUpload = req.files.image[0];
      updates.userImage = iconUpload.filename;
    }
    const update = { $set: updates };
    if (Object.keys(unset).length) update.$unset = unset;
    const updatedUser = await User.findByIdAndUpdate(userId, update, {
      new: true,
      runValidators: true,
    }).select("-password -otp -otpExpiration -otpAttempts");

    if (!updatedUser) {
      return res.status(404).json({ message: "User not found" });
    }

    res.status(200).json({
      message: "Profile updated successfully",
      user: toPublicUser(updatedUser),
    });
  } catch (error) {
    if (error.name === "ValidationError" || error.name === "CastError") {
      return res.status(400).json({ message: "Invalid profile data", error: error.message });
    }
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
    const pageNumber = Math.max(1, parseInt(page, 10));
    const pageLimit = Math.max(1, parseInt(limit, 10));
    const skip = (pageNumber - 1) * pageLimit;

    // Build search query
    let searchQuery = {};
    if (search) {
      // Find businesses matching search
      const pattern = searchPattern(search);
      const matchingBusinesses = await Business.find({ 
        businessName: { $regex: pattern, $options: "i" } 
      }).select("_id");
      const businessIds = matchingBusinesses.map(b => b._id);

      searchQuery.$or = [
        { email: { $regex: pattern, $options: "i" } },
        { phone: { $regex: pattern, $options: "i" } },
        { full_name: { $regex: pattern, $options: "i" } },
        { businesses: { $in: businessIds } }
      ];
    }
    if (country) {
      searchQuery.country = { $regex: exactInsensitive(country) };
    }

    // Fetch users with populated business names
    const users = await User.find(searchQuery)
      .populate({
        path: "businesses",
        select:
          "businessName userId address.city address.area address.state address.country",
      })
      .skip(skip)
      .limit(pageLimit)
      .lean(); // For better performance

    const totalUsers = await User.countDocuments(searchQuery);

    // Format response with business names
    const formattedUsers = users.map((user) => {
      // Filter out businesses that no longer point back to this user (stale data)
      const validBusinesses = user.businesses?.filter(
        (b) => b && b.userId && b.userId.toString() === user._id.toString()
      ) || [];

      const businessNames =
        validBusinesses.length > 0
          ? validBusinesses.map((b) => b.businessName).join(", ")
          : "No Business";

      const businessAddresses =
        validBusinesses.length > 0
          ? validBusinesses
              .map((b) => {
                const addr = b.address;
                return `${addr.area || ""}, ${addr.city || ""}, ${
                  addr.state || ""
                }, ${addr.country || ""}`
                  .replace(/,\s*,/g, ",")
                  .trim();
              })
              .join(" | ")
          : "N/A";

      return {
        _id: user._id,
        full_name: user.full_name || "N/A",
        email: user.email,
        phone: user.phone || "N/A",
        isSeller: validBusinesses.length > 0, // Reflect actual ownership
        businessNames,
        businessAddresses,
        country: user.country || "N/A",
        createdAt: user.createdAt,
      };
    });

    res.json({
      users: formattedUsers,
      totalUsers,
      pagination: {
        currentPage: pageNumber,
        totalPages: Math.ceil(totalUsers / pageLimit),
        limit: pageLimit,
      },
    });
  } catch (error) {
    console.error("Error fetching users:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// delete by id
exports.deleteById = async (req, res) => {
  try {
    const { id } = req.params;

    // 1. Find the user to get their businesses
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // 2. Update all businesses owned by this user
    // Mark them as unowned and not claimed
    await Business.updateMany(
      { userId: id },
      { 
        $set: { 
          userId: null, 
          claimed: false, 
          verified: false 
        } 
      }
    );

    // 3. Delete the user
    await User.findByIdAndDelete(id);

    res.status(200).json({ message: "User and their business associations cleared successfully" });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
    console.log(error);
  }
};

exports.fetchUserLocation = async (req, res) => {
  const { lat, lon } = req.query;

  try {
    if (!lat || !lon) {
      // Fallback to IP-based detection if GPS coordinates are missing
      const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "";
      const ipClean = ip.split(",")[0].trim();
      
      const ipResponse = await axios.get(`http://ip-api.com/json/${ipClean}`);
      if (ipResponse.data && ipResponse.data.status === "success") {
        return res.status(200).json({
          address: {
            country: ipResponse.data.country,
            country_code: ipResponse.data.countryCode,
            state: ipResponse.data.regionName,
            city: ipResponse.data.city,
            postcode: ipResponse.data.zip
          }
        });
      }
      return res.status(400).json({ error: "Location coordinates or valid IP required" });
    }

    const data = await geocodingService.reverseGeocode(lat, lon);
    return res.status(200).json(data);
  } catch (error) {
    console.error("Reverse geocoding error:", error.message);
    res.status(500).json({ error: "Failed to reverse geocode" });
  }
};


exports.fetchCoordinates = async (req, res) => {
  try {
    const { address } = req.body;

    if (!address?.trim()) {
      return res.status(400).json({ message: "Address is required" });
    }

    const results = await geocodingService.forwardGeocode(address);

    if (!results || !results.length) {
      return res.status(404).json({ message: "Address not found" });
    }

    const result = results[0];
    const { lat, lon, display_name, address: addressDetails } = result;

    return res.json({
      latitude: Number(lat),
      longitude: Number(lon),
      displayName: display_name,
      addressDetails
    });

  } catch (error) {
    console.error("Geocoding error:", error.message);
    res.status(500).json({ message: "Geocoding service unavailable" });
  }
};

exports.exportUsersToExcel = async (req, res) => {
  try {
    // Fetch all users with populated businesses
    const users = await User.find({})
      .populate({
        path: "businesses",
        select:
          "businessName address.area address.city address.state address.country address.streetName",
      })
      .lean();

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Users");

    // Columns
    worksheet.columns = [
      { header: "Customer Name", key: "full_name", width: 25 },
      { header: "Email", key: "email", width: 30 },
      { header: "Phone Number", key: "phone", width: 20 },
      { header: "Business Name", key: "businessName", width: 35 },
      { header: "Business Address", key: "businessAddress", width: 50 },
      { header: "Is Seller", key: "isSeller", width: 12 },
      { header: "Country", key: "country", width: 15 },
      { header: "Created At", key: "createdAt", width: 20 },
    ];

    // Header Style
    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
    headerRow.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1976D2" },
    };
    headerRow.alignment = { vertical: "middle", horizontal: "center" };

    // Add rows — One row per business
    users.forEach((user) => {
      const businesses = user.businesses || [];
      const userBaseData = {
        full_name: user.full_name || "N/A",
        email: user.email || "N/A",
        phone: user.phone || "N/A",
        isSeller: user.isSeller ? "Yes" : "No",
        country: user.country || "N/A",
        createdAt: new Date(user.createdAt).toLocaleDateString("en-GB"), // DD/MM/YYYY
      };

      if (businesses.length === 0) {
        // No business → one row with N/A
        worksheet.addRow({
          ...userBaseData,
          businessName: "No Business",
          businessAddress: "N/A",
        });
      } else {
        // One row per business
        businesses.forEach((business) => {
          const addr = business.address || {};
          const fullAddress =
            [addr.streetName, addr.area, addr.city, addr.state, addr.country]
              .filter(Boolean)
              .join(", ")
              .trim() || "Location N/A";

          worksheet.addRow({
            ...userBaseData,
            businessName: business.businessName || "N/A",
            businessAddress: fullAddress,
          });
        });
      }
    });

    // Response headers
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=UrbanCitations_Users_${
        new Date().toISOString().split("T")[0]
      }.xlsx`
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error("Export error:", error);
    res.status(500).json({ message: "Export failed", error: error.message });
  }
};
