const Business = require("../models/Business");
const User = require("../models/User");
const path = require('path');
const { default: mongoose } = require("mongoose");
const validator = require('validator');

///this api use combine for admin and users
exports.createBusiness = async (req, res) => {
  try {
    const loggedInUserId = req.user.id;

    // Parse JSON safely
    let businessData;
    try {
      businessData = JSON.parse(req.body.businessData);
    } catch {
      return res.status(400).json({ message: "Invalid business data format." });
    }

    if (!businessData) {
      return res.status(400).json({ message: "Add all mandatory fields." });
    }

    const { userId: providedUserId } = businessData; // Corrected from 'useid' to 'userId'
    const isAdmin = req.user?.role === "admin";
    const userId = isAdmin && providedUserId ? providedUserId : loggedInUserId;

    // ✅ Convert coordinates to GeoJSON
    const coords = businessData.address?.coordinates;
    if (!coords?.latitude || !coords?.longitude) {
      return res.status(400).json({ message: "Latitude and longitude are required." });
    }

    businessData.location = {
      type: "Point",
      coordinates: [coords.longitude, coords.latitude],
    };

    delete businessData.address.coordinates; // Remove raw coords from address

    // ✅ Attach uploaded file names (not full paths)
    const businessLogo = req.files?.businessLogo?.[0];
    const photos = req.files?.photos || [];

    if (businessLogo) {
      businessData.businessLogo = businessLogo.filename; // ⬅️ store only filename
    }

    businessData.photos = photos.map((photo) => photo.filename); // ⬅️ store only filenames

    // ✅ Initialize and validate contact object
    businessData.contact = businessData.contact || {};
    if (businessData.contact.contactDetails && Array.isArray(businessData.contact.contactDetails)) {
      businessData.contact.contactDetails = businessData.contact.contactDetails.map((contact) => ({
        title: contact.title || "Mr",
        name: contact.name || "Default Name", // Default to a non-empty value
        designation: contact.designation || "",
        mobileNumbers: contact.mobileNumbers?.filter((num) => num.trim()) || [""],
        whatsappNumbers: contact.whatsappNumbers?.filter((num) => num.trim()) || [""],
        emails: contact.emails?.filter((email) => email.trim()) || [""],
      }));
    } else {
      // Initialize with at least one valid contact detail
      businessData.contact.contactDetails = [{
        title: "Mr",
        name: "Default Name", // Ensure name is not empty
        designation: "",
        mobileNumbers: businessData.contact.mobile || [""],
        whatsappNumbers: businessData.contact.whatsapp || [""],
        emails: businessData.contact.email || [""],
      }];
    }

    // Handle legacy fields if provided (optional)
    if (businessData.contact.customerName) businessData.contact.customerName = businessData.contact.customerName;
    if (businessData.contact.mobile) businessData.contact.mobile = businessData.contact.mobile.filter((num) => num.trim());
    if (businessData.contact.whatsapp) businessData.contact.whatsapp = businessData.contact.whatsapp.filter((num) => num.trim());
    if (businessData.contact.email) businessData.contact.email = businessData.contact.email.filter((email) => email.trim());
    businessData.claimed = true;
    // ✅ Create and save business
    const newBusiness = new Business(businessData);
    newBusiness.userId = userId; // Use the determined userId
    const savedBusiness = await newBusiness.save();

    // ✅ Attach business to user
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found." });

    user.businesses.push(savedBusiness._id);
    user.isSeller = true;
    await user.save();

    res.status(201).json({ success: true, business: savedBusiness });
  } catch (error) {
    console.error("error--->: ", error);
    res.status(400).json({
      success: false,
      message: error._message || error.message || "Failed to create business",
      errors: error.errors, // Include detailed errors for debugging
    });
  }
};

///this api use combnie for admin and users
exports.getBusiness = async (req, res) => {
  try {
    const { page = 1, limit = 10, search = "", country = "", verified, trust, claimed } = req.query;

    // Validate pagination parameters
    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.max(1, Number(limit));
    const skip = (pageNum - 1) * limitNum;

    // Build query object
    let query = {};
    if (search) {
      query = {
        $or: [
          { businessName: { $regex: search, $options: "i" } },
          { "address.city": { $regex: search, $options: "i" } },
          { "address.area": { $regex: search, $options: "i" } },
          { "contact.email": { $regex: search, $options: "i" } },
          { "contact.mobile": { $regex: search, $options: "i" } },
          { "contact.contactDetails.name": { $regex: search, $options: "i" } },
          { "contact.contactDetails.mobileNumbers": { $regex: search, $options: "i" } },
          { "contact.contactDetails.whatsappNumbers": { $regex: search, $options: "i" } },
          { "contact.contactDetails.emails": { $regex: search, $options: "i" } },
        ],
      };
    }
    if (country) {
      query["address.country"] = { $regex: new RegExp(`^${country}$`, "i") };
    }
    // Add status filters
    const statusFilters = {};
    if (verified !== undefined) statusFilters.verified = verified === 'true';
    if (trust !== undefined) statusFilters.trust = trust === 'true';
    if (claimed !== undefined) statusFilters.claimed = claimed === 'true';
    if (Object.keys(statusFilters).length > 0) {
      query = { ...query, ...statusFilters };
    }

    // Fetch businesses with pagination
    const businesses = await Business.find(query)
      .select('businessName address contact businessTiming verified trust claimed isBlocked subscriptionActive _id')
      .skip(skip)
      .limit(limitNum)
      .lean();

    const total = await Business.countDocuments(query);

    res.status(200).json({
      businesses,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum),
    });
  } catch (error) {
    console.error('Error fetching businesses:', error.message);
    res.status(500).json({ message: 'Internal server error', error: error.message });
  }
};

exports.getBusinessById = async (req, res) => {
  try {
    const { id } = req.params;

    const business = await Business.findById(id)
      .populate("category")
      .populate("subCategory");

    if (!business) {
      return res.status(404).json({
        success: false,
        message: "Business not found",
      });
    }

    // Calculate profile completion score
    const criteria = {
      businessName: { weight: 10, check: !!business.businessName },
      address: { weight: 15, check: business.address && Object.keys(business.address).some(key => !!business.address[key]) },
      contact: { weight: 15, check: business.contact && (business.contact.mobile.length || business.contact.email.length || business.contact.contactDetails.length) },
      businessTiming: { weight: 10, check: business.businessTiming && (business.businessTiming.isOpen24Hours || business.businessTiming.daysOfWeek.length || Object.keys(business.businessTiming.schedule || {}).length) },
      kyc: { weight: 10, check: business.kyc && business.kyc.status !== 'pending' },
      category: { weight: 10, check: business.category && business.category.length > 0 },
      subCategory: { weight: 5, check: business.subCategory && business.subCategory.length > 0 },
      photos: { weight: 5, check: business.photos && business.photos.length > 0 },
      socialLinks: { weight: 5, check: business.socialLinks && Object.keys(business.socialLinks).length > 0 },
      website: { weight: 5, check: !!business.website },
      videoUrl: { weight: 5, check: !!business.videoUrl },
      businessSummary: { weight: 5, check: !!business.businessSummary },
      yearsOfEstablishment: { weight: 5, check: business.yearsOfEstablishment > 0 },
    };

    const totalWeight = Object.values(criteria).reduce((sum, { weight }) => sum + weight, 0);
    const completedWeight = Object.values(criteria).reduce((sum, { weight, check }) => sum + (check ? weight : 0), 0);
    const profileCompletionScore = Math.round((completedWeight / totalWeight) * 100);

    // Update the business with the score
    const updatedBusiness = await Business.findByIdAndUpdate(
      id,
      { $set: { profileCompletionScore } },
      { new: true, runValidators: true }
    )
      .populate("category")
      .populate("subCategory");

    // Determine pending actions
    const pendingActions = Object.entries(criteria)
      .filter(([, { check }]) => !check)
      .map(([key]) => {
        switch (key) {
          case 'businessName': return 'Add Business Name';
          case 'address': return 'Complete Address Details';
          case 'contact': return 'Add Contact Information';
          case 'businessTiming': return 'Set Business Timings';
          case 'kyc': return 'Complete KYC Verification';
          case 'category': return 'Add Business Category';
          case 'subCategory': return 'Add Sub-Category';
          case 'photos': return 'Upload Photos';
          case 'socialLinks': return 'Add Social Links';
          case 'website': return 'Add Website';
          case 'videoUrl': return 'Add Video';
          case 'businessSummary': return 'Add Business Summary';
          case 'yearsOfEstablishment': return 'Add Years of Establishment';
          default: return 'Complete Additional Info';
        }
      });

    return res.json({
      success: true,
      message: "Business fetched successfully",
      business: updatedBusiness,
      pendingActions, // Ensure this is included in the response
    });
  } catch (err) {
    console.error("Error fetching business:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

exports.updateBusinessContactDetails = async (req, res) => {
  try {
    const { id } = req.params;
    const { contact } = req.body;

    if (!id || !contact || !Array.isArray(contact.contactDetails)) {
      return res.status(400).json({
        success: false,
        message: "Business ID and valid contact object with contactDetails array are required",
      });
    }

    const business = await Business.findById(id);
    if (!business) {
      return res.status(404).json({
        success: false,
        message: "Business not found",
      });
    }

    // Initialize contactDetails if it doesn't exist
    if (!business.contact) business.contact = {};
    if (!business.contact.contactDetails) business.contact.contactDetails = [];

    // Update contactDetails
    business.contact.contactDetails = contact.contactDetails.map((detail) => ({
      title: detail.title || 'Mr',
      name: detail.name?.trim() || '',
      designation: detail.designation?.trim() || '',
      mobileNumbers: detail.mobileNumbers?.filter(num => num?.trim()) || [''],
      whatsappNumbers: detail.whatsappNumbers?.filter(num => num?.trim()) || [''],
      emails: detail.emails?.filter(email => email?.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) || [''],
    }));

    await business.save();

    return res.status(200).json({
      success: true,
      message: "Contact details updated successfully",
      business: business,
    });
  } catch (err) {
    console.error("Error updating contact details:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: err.message,
    });
  }
};

exports.searchServices = async (req, res) => {
  try {
    const { query, location } = req.query;

    if (!query || !location) {
      return res
        .status(400)
        .json({ message: "Location (address) is required" });
    }

    const services = await Business.aggregate([
      {
        $lookup: {
          from: "categories",
          localField: "category",
          foreignField: "_id",
          as: "categoryDetails",
        },
      },
      {
        $lookup: {
          from: "subcategories",
          localField: "subCategory",
          foreignField: "_id",
          as: "subCategoryDetails",
        },
      },
      {
        $match: {
          addressString: { $regex: location, $options: "i" },
          $or: [
            { businessName: { $regex: query, $options: "i" } },
            { "categoryDetails.name": { $regex: query, $options: "i" } },
            { "subCategoryDetails.name": { $regex: query, $options: "i" } },
            { servicesTypes: { $elemMatch: { $regex: query, $options: "i" } } },
            { "contact.contactDetails.name": { $regex: query, $options: "i" } },
            { "contact.contactDetails.mobileNumbers": { $regex: query, $options: "i" } },
            { "contact.contactDetails.whatsappNumbers": { $regex: query, $options: "i" } },
            { "contact.contactDetails.emails": { $regex: query, $options: "i" } },
          ],
        },
      },
      {
        $unwind: {
          path: "$categoryDetails",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $unwind: {
          path: "$subCategoryDetails",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $project: {
          _id: 1,
          businessName: 1,
          description: 1,
          isBlocked: 1,
          address: 1,
          contact: 1,
          businessTiming: 1,
          category: "$categoryDetails.name",
          subCategory: "$subCategoryDetails.name",
          photos: 1,
          rating: 1,
          totalReviews: 1,
          verified: 1,
          trust: 1,
          claimed: 1,
          enquiryCount: 1,
          openUntil: 1,
          yearsOfEstablishment: 1,
          servicesTypes: 1,
          hygiene: 1,
          businessSummary: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      },
    ]);

    if (services.length === 0) {
      return res
        .status(404)
        .json({ message: "No services found matching your criteria" });
    }

    return res.status(200).json({
      message: "Services found",
      businesses: services,
    });
  } catch (error) {
    console.error(error);
    return res
      .status(500)
      .json({ message: "Error searching for services", error: error.message });
  }
};

exports.blockBusiness = async (req, res) => {
  try {
    const { businessId } = req.params;
    const { isBlocked } = req.body;
    if (!businessId)
      return res.status(401).json({ message: "missig businessid" });
    const business = await Business.findById(businessId);
    if (!business) {
      return res.status(404).json({ message: "Business not found" });
    }
    const updateData = {
      isBlocked: isBlocked,
    };
    const result = await Business.updateOne(
      { _id: businessId },
      { $set: updateData }
    );
    if (result.modifiedCount === 0) {
      return res
        .status(400)
        .json({ message: "No changes were made, or business already blocked" });
    }
    res
      .status(200)
      .json({ message: "Business successfully blocked", business });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.deleteBusiness = async (req, res) => {
  try {
    const { businessId } = req.params;
    const business = await Business.findByIdAndDelete(businessId);
    if (!business) {
      return res.status(404).json({ message: "Business not found" });
    }
    const user = await User.findOne({ businesses: businessId });
    if (user) {
      user.businesses.pull(businessId);
      user.isSeller = false;
      await user.save();
    }
    res.status(200).json({ message: "Business successfully deleted" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.updateBusiness = async (req, res) => {
  try {
    const { businessData } = req.body;

    if (!businessData) {
      return res.status(400).json({ message: "Missing businessData" });
    }

    const parsedData = JSON.parse(businessData);
    const { _id: businessId } = parsedData;

    if (!businessId) {
      return res.status(400).json({ message: "Business ID is required" });
    }

    const business = await Business.findById(businessId);
    if (!business) {
      return res.status(404).json({ message: "Business not found" });
    }

    // ✅ Extract allowed fields
    const allowedFields = [
      "businessName",
      "contact",
      "address",
      "businessSummary",
      "businessTiming",
      "isOpen24Hours",
      "yearsOfEstablishment",
      "photos",
      "verified", // Added for status update
      "trust",    // Added for status update
      "claimed",  // Added for status update
    ];

    const updates = {};
    for (const field of allowedFields) {
      if (parsedData.hasOwnProperty(field)) {
        updates[field] = parsedData[field];
      }
    }

    // ✅ Handle contact.contactDetails specifically
    if (parsedData.contact?.contactDetails && Array.isArray(parsedData.contact.contactDetails)) {
      updates.contact = updates.contact || {};
      updates.contact.contactDetails = parsedData.contact.contactDetails.map((contact) => ({
        title: contact.title || "Mr",
        name: contact.name || "",
        designation: contact.designation || "",
        mobileNumbers: contact.mobileNumbers?.filter((num) => num.trim()) || [""],
        whatsappNumbers: contact.whatsappNumbers?.filter((num) => num.trim()) || [""],
        emails: contact.emails?.filter((email) => email.trim()) || [""],
      }));
    }

    // ✅ Handle uploaded businessLogo
    if (req.files?.businessLogo?.[0]) {
      const logoFileName = path.basename(req.files.businessLogo[0].path);
      updates.businessLogo = logoFileName;
    }

    // ✅ Handle uploaded photos
    if (req.files?.photos) {
      const photoFileNames = req.files.photos.map((file) => path.basename(file.path));
      updates.photos = [...(updates.photos || business.photos || []), ...photoFileNames];
    }

    updates.updatedAt = new Date();

    const updatedBusiness = await Business.findByIdAndUpdate(
      businessId,
      updates,
      { new: true }
    );

    return res.status(200).json({
      message: "Business updated successfully",
      business: updatedBusiness,
    });
  } catch (err) {
    console.error("Error updating business:", err);
    return res
      .status(500)
      .json({ message: "Failed to update business", error: err.message });
  }
};

exports.updateBusinessStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { verified, trust, claimed } = req.body;

    const updateData = {};
    if (verified !== undefined) updateData.verified = Boolean(verified);
    if (trust !== undefined) updateData.trust = Boolean(trust);
    if (claimed !== undefined) updateData.claimed = Boolean(claimed);

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ message: 'No status updates provided' });
    }

    const business = await Business.findByIdAndUpdate(id, { $set: updateData }, { new: true, runValidators: true });
    if (!business) {
      return res.status(404).json({ message: 'Business not found' });
    }

    res.status(200).json({ message: 'Business status updated successfully', business });
  } catch (error) {
    console.error('Error updating business status:', error.message);
    res.status(500).json({ message: 'Internal server error', error: error.message });
  }
};

exports.updateSocialInfo = async (req, res) => {
  const { businessId } = req.params;
  console.log('Request body:', req.body); // Debug log
  const { website, videoUrl: providedVideoUrl } = req.body;

  let socialLinks = req.body.socialLinks ? JSON.parse(req.body.socialLinks) : {};

  if (!mongoose.Types.ObjectId.isValid(businessId)) {
    return res.status(400).json({ success: false, message: 'Invalid business ID' });
  }

  try {
    const business = await Business.findById(businessId);
    if (!business) {
      return res.status(404).json({ success: false, message: 'Business not found' });
    }

    const updateData = {};
    if (socialLinks && typeof socialLinks === 'object') {
      updateData.socialLinks = socialLinks;
    } else {
      return res.status(400).json({ success: false, message: 'socialLinks must be an object' });
    }

    if (website && !validator.isURL(website, { protocols: ['http', 'https'], require_protocol: true })) {
      return res.status(400).json({ success: false, message: 'Invalid website URL' });
    }
    if (website) updateData.website = website;

    let finalVideoUrl = providedVideoUrl;
    if (req.file) {
      // For S3, use the full S3 URL
      finalVideoUrl = `https://${process.env.AWS_BUCKET_NAME}.s3.amazonaws.com/${req.file.key}`;
    } else if (providedVideoUrl && !validator.isURL(providedVideoUrl, { protocols: ['http', 'https'], require_protocol: true })) {
      return res.status(400).json({ success: false, message: 'Invalid video URL' });
    }
    if (finalVideoUrl) updateData.videoUrl = finalVideoUrl;

    const updatedBusiness = await Business.findByIdAndUpdate(
      businessId,
      { $set: updateData },
      { new: true, runValidators: true }
    );

    if (!updatedBusiness) {
      return res.status(500).json({ success: false, message: 'Failed to update business' });
    }

    res.status(200).json({ success: true, message: 'Social information updated successfully', business: updatedBusiness });
  } catch (err) {
    console.error('Error updating social info:', err);
    res.status(500).json({ success: false, message: 'Server error while updating social information', error: err.message });
  }
};

exports.calculateProfileCompletionScore = async (req, res) => {
  const { businessId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(businessId)) {
    return res.status(400).json({ success: false, message: 'Invalid business ID' });
  }

  try {
    const business = await Business.findById(businessId);
    if (!business) {
      return res.status(404).json({ success: false, message: 'Business not found' });
    }

    // Define completion criteria and weights (total = 100%)
    const criteria = {
      businessName: { weight: 10, check: !!business.businessName },
      address: { weight: 15, check: business.address && Object.keys(business.address).some(key => !!business.address[key]) },
      contact: { weight: 15, check: business.contact && (business.contact.mobile.length || business.contact.email.length || business.contact.contactDetails.length) },
      businessTiming: { weight: 10, check: business.businessTiming && (business.businessTiming.isOpen24Hours || business.businessTiming.daysOfWeek.length || Object.keys(business.businessTiming.schedule || {}).length) },
      kyc: { weight: 10, check: business.kyc && business.kyc.status !== 'pending' },
      category: { weight: 10, check: business.category && business.category.length > 0 },
      subCategory: { weight: 5, check: business.subCategory && business.subCategory.length > 0 },
      photos: { weight: 5, check: business.photos && business.photos.length > 0 },
      socialLinks: { weight: 5, check: business.socialLinks && Object.keys(business.socialLinks).length > 0 },
      website: { weight: 5, check: !!business.website },
      videoUrl: { weight: 5, check: !!business.videoUrl },
      businessSummary: { weight: 5, check: !!business.businessSummary },
      yearsOfEstablishment: { weight: 5, check: business.yearsOfEstablishment > 0 },
    };

    // Calculate total possible score
    const totalWeight = Object.values(criteria).reduce((sum, { weight }) => sum + weight, 0); // Should be 100

    // Calculate completed score
    const completedWeight = Object.values(criteria).reduce((sum, { weight, check }) => sum + (check ? weight : 0), 0);

    // Calculate percentage
    const profileCompletionScore = Math.round((completedWeight / totalWeight) * 100);

    // Update the business document
    const updatedBusiness = await Business.findByIdAndUpdate(
      businessId,
      { $set: { profileCompletionScore } },
      { new: true, runValidators: true }
    );

    // Determine pending actions
    const pendingActions = Object.entries(criteria)
      .filter(([, { check }]) => !check)
      .map(([key]) => {
        switch (key) {
          case 'businessName': return 'Add Business Name';
          case 'address': return 'Complete Address Details';
          case 'contact': return 'Add Contact Information';
          case 'businessTiming': return 'Set Business Timings';
          case 'kyc': return 'Complete KYC Verification';
          case 'category': return 'Add Business Category';
          case 'subCategory': return 'Add Sub-Category';
          case 'photos': return 'Upload Photos';
          case 'socialLinks': return 'Add Social Links';
          case 'website': return 'Add Website';
          case 'videoUrl': return 'Add Video';
          case 'businessSummary': return 'Add Business Summary';
          case 'yearsOfEstablishment': return 'Add Years of Establishment';
          default: return 'Complete Additional Info';
        }
      });

    res.status(200).json({
      success: true,
      message: 'Profile completion score calculated successfully',
      business: updatedBusiness,
      pendingActions,
    });
  } catch (err) {
    console.error('Error calculating profile completion score:', err);
    res.status(500).json({ success: false, message: 'Server error while calculating profile completion score', error: err.message });
  }
};

exports.updateKYC = async (req, res) => {
  try {
    const { businessData } = req.body;

    if (!businessData) {
      return res.status(400).json({ message: "Missing businessData" });
    }

    const parsedData = JSON.parse(businessData);
    const { _id: businessId } = parsedData;

    if (!businessId) {
      return res.status(400).json({ message: "Business ID is required" });
    }

    const business = await Business.findById(businessId);
    if (!business) {
      return res.status(404).json({ message: "Business not found" });
    }

    const updates = {};
    if (parsedData.kyc) {
      updates.kyc = {
        country: parsedData.kyc.country,
        documents: {}, // Map of document type to filename
        status: 'pending',
      };
    }

    // Handle uploaded KYC documents with their types
    if (req.files && req.files.length > 0) {
      const requiredDocs = {
        USA: ['Certificate of Incorporation', 'Employer Identification Number (EIN)', 'Proof of Identity (Passport/Driver\'s License)', 'Proof of Address (Utility Bill/Bank Statement)', 'Business License/Permit'],
        Europe: ['Articles of Association', 'Proof of Identity (Passport/ID Card)', 'Proof of Address', 'Notarized Registration Documents', 'Tax ID/VAT Number'],
        India: ['PAN Card', 'Aadhaar Card', 'Director Identification Number (DIN)', 'Digital Signature Certificate (DSC)', 'Memorandum of Association (MoA)', 'Articles of Association (AoA)', 'Proof of Registered Office (Utility Bill/Lease)'],
      };
      const countryDocs = requiredDocs[parsedData.kyc.country] || [];
      req.files.forEach((file, index) => {
        if (index < countryDocs.length) {
          updates.kyc.documents[countryDocs[index]] = path.basename(file.path);
        }
      });
    }

    const updatedBusiness = await Business.findByIdAndUpdate(businessId, updates, { new: true });

    return res.status(200).json({
      message: "KYC documents updated successfully",
      business: updatedBusiness,
    });
  } catch (err) {
    console.error("Error updating KYC:", err);
    return res.status(500).json({ message: "Failed to update KYC", error: err.message });
  }
};

exports.deleteKYCDocument = async (req, res) => {
  try {
    const { id } = req.params;
    const { docName } = req.body;

    if (!id || !docName) {
      return res.status(400).json({ message: "Business ID and document name are required" });
    }

    const business = await Business.findById(id);
    if (!business) {
      return res.status(404).json({ message: "Business not found" });
    }

    if (business.kyc && business.kyc.documents && business.kyc.documents.has(docName)) {
      // Use updateOne to modify only the kyc.documents field without full validation
      await Business.updateOne(
        { _id: id },
        { $unset: { [`kyc.documents.${docName}`]: 1 } } // Remove the specific document
      );
      return res.status(200).json({ message: "Document deleted successfully" });
    }

    return res.status(404).json({ message: "Document not found" });
  } catch (err) {
    console.error("Error deleting KYC document:", err);
    return res.status(500).json({ message: "Failed to delete document", error: err.message });
  }
};

exports.getuserBusiness = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId).populate("businesses").exec();

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    return res.status(200).json({
      full_name: user.full_name,
      email: user.email,
      userImage: user.userImage,
      isSeller: user.isSeller,
      businesses: user.businesses,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

exports.getAllBusiness = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      category,
      isOpenNow,
      isTopRated,
      isQuickResponse,
      isVerified,
      hasDeals,
      isTrusted,
      sortBy,
      type,
      lat,
      lon,
      radius = 100,    // kilometers
    } = req.query;

    if (!lat || !lon) {
      return res.status(400).json({
        success: false,
        message: "Query parameters `lat` and `lon` are required.",
      });
    }

    const skip = (Number(page) - 1) * Number(limit);

    // Convert radius to radians: radius_in_meters / Earth's radius in meters (≈ 6,378,100 m)
    const radiusInRad = Number(radius) * 1000 / 6378100;

    // Build filters
    const filters = {
      isBlocked: false,

      // Geospatial: everything within the sphere
      "location": {
        $geoWithin: {
          $centerSphere: [
            [Number(lon), Number(lat)],
            radiusInRad
          ]
        }
      },
      ...(category && { category }),
      ...(isVerified === "true" && { verified: true }),
      ...(isTrusted === "true" && { trust: true }),
      ...(type && { type: { $in: type.split(",") } }),
      ...(isTopRated === "true" && { rating: { $gte: 4.5 } }),
      ...(isQuickResponse === "true" && { quickResponse: true }),
      ...(hasDeals === "true" && { deals: { $exists: true, $not: { $size: 0 } } }),
    };

    // Handle isOpenNow
    if (isOpenNow === "true") {
      const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
      const now = new Date();
      const dayKey = days[now.getDay()];
      const hh = now.getHours().toString().padStart(2,"0");
      const mm = now.getMinutes().toString().padStart(2,"0");
      const currentTime = `${hh}:${mm}`;

      filters.$or = [
        { "businessTiming.isOpen24Hours": true },
        {
          $expr: {
            $gt: [
              {
                $size: {
                  $filter: {
                    input: { $ifNull: [`$businessTiming.schedule.${dayKey}`, []] },
                    as: "slot",
                    cond: {
                      $and: [
                        { $lte: ["$$slot.openAt", currentTime] },
                        { $gte: ["$$slot.closeAt", currentTime] },
                      ],
                    },
                  },
                },
              },
              0
            ]
          }
        }
      ];
    }

    // Sorting
    let sortCondition = {};
    if (sortBy === "A-Z") sortCondition = { businessName: 1 };
    else if (sortBy === "Z-A") sortCondition = { businessName: -1 };
    else if (sortBy === "Newest") sortCondition = { createdAt: -1 };
    else if (sortBy === "Oldest") sortCondition = { createdAt: 1 };

    const [businesses, total] = await Promise.all([
      Business.find(filters)
        .populate("category")
        .sort(sortCondition)
        .skip(skip)
        .limit(Number(limit)),
      Business.countDocuments(filters),
    ]);

    return res.status(200).json({
      success: true,
      page: Number(page),
      limit: Number(limit),
      total,
      businesses,
    });
  } catch (error) {
    console.error("getAllBusiness error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};


exports.checkPhoneExists = async (req, res) => {
  try {
    const { phone } = req.body;
    const existingUser = await User.findOne({ phone });
    if (existingUser) {
      return res.status(409).json({
        available: false,
        message: "Phone number already exists",
        success: false,
      });
    }
    return res.status(200).json({
      available: true,
      message: "Phone number available",
      success: true,
    });
  } catch (error) {
    res.status(500).json({ message: "Internal Server error" });
  }
};
