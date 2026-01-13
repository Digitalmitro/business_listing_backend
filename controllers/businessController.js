const Business = require("../models/Business");
const User = require("../models/User");
const path = require("path");
const { default: mongoose } = require("mongoose");
const validator = require("validator");
const Category = require("../models/Category");
const SubCategory = require("../models/SubCategory");
const Enquiry = require("../models/Enquiry");
const Offer = require("../models/Offer");
const toObjectIdArray = require("../helpers/convertToObjectId");
const csv = require("csv-parser");
const fs = require("fs");
const { addJob } = require("../utils/queue");

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

    const isAdmin = req.user?.role === "admin";
    let userId = loggedInUserId;

    // For admins, allow business creation without user attachment
    if (isAdmin) {
      userId = null;
    }

    // Convert coordinates to GeoJSON
    const coords = businessData.address?.coordinates;
    if (!coords?.latitude || !coords?.longitude) {
      return res
        .status(400)
        .json({ message: "Latitude and longitude are required." });
    }

    // Normalize categories (handle 'categories' vs 'category' and object vs ID string)
    let rawCategories = businessData.categories || businessData.category || [];
    // If it's not an array, make it one (though it should be)
    if (!Array.isArray(rawCategories)) rawCategories = [rawCategories];

    const validCategories = rawCategories
      .map((item) => (typeof item === "object" && item._id ? item._id : item))
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    // Normalize subCategories
    let rawSubCategories =
      businessData.subCategories || businessData.subCategory || [];
    if (!Array.isArray(rawSubCategories)) rawSubCategories = [rawSubCategories];

    const validSubCategories = rawSubCategories
      .map((item) => (typeof item === "object" && item._id ? item._id : item))
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    // Verify categories exist (since category is required)
    if (validCategories.length === 0) {
      return res
        .status(400)
        .json({ message: "At least one category is required." });
    }
    const existingCategories = await Category.find({
      _id: { $in: validCategories },
    });
    if (existingCategories.length !== validCategories.length) {
      return res
        .status(400)
        .json({ message: "One or more categories are invalid." });
    }

    // Verify subCategories exist
    if (validSubCategories.length > 0) {
      const existingSubCategories = await SubCategory.find({
        _id: { $in: validSubCategories },
      });
      if (existingSubCategories.length !== validSubCategories.length) {
        return res
          .status(400)
          .json({ message: "One or more subcategories are invalid." });
      }
    }

    // Attach uploaded file names
    const businessLogo = req.files?.businessLogo?.[0];
    const photos = Array.isArray(req.files?.photos)
      ? req.files.photos
      : req.files?.photos
      ? [req.files.photos]
      : [];

    console.log("Received files:", req.files);
    console.log("Processed photos:", photos);
    console.log("Category:", validCategories);
    console.log("SubCategory:", validSubCategories);

    // Initialize and validate contact object
    const contact = businessData.contact || {};
    const { mobile, whatsapp, email, contactDetails } = contact;

    // Handle contactDetails
    const validatedContactDetails =
      contactDetails && Array.isArray(contactDetails)
        ? contactDetails.map((contact) => ({
            title: contact.title || "Mr",
            name: contact.name || "Default Name",
            designation: contact.designation || "",
            mobileNumbers: mobile?.filter((num) => num.trim()) || [""],
            whatsappNumbers: whatsapp?.filter((num) => num.trim()) || [""],
            emails: email?.filter((em) => em.trim()) || [""],
          }))
        : [
            {
              title: "Mr",
              name: contactDetails?.[0]?.name || "Default Name",
              designation: contactDetails?.[0]?.designation || "",
              mobileNumbers: mobile?.filter((num) => num.trim()) || [""],
              whatsappNumbers: whatsapp?.filter((num) => num.trim()) || [""],
              emails: email?.filter((em) => em.trim()) || [""],
            },
          ];

    // Create business object explicitly
    const newBusinessData = {
      businessName: businessData.businessName,
      address: {
        blockName: businessData.address?.blockName || "",
        streetName: businessData.address?.streetName,
        area: businessData.address?.area,
        country: businessData.address?.country,
        landmark: businessData.address?.landmark || "",
        pincode: businessData.address?.pincode,
        city: businessData.address?.city,
        state: businessData.address?.state,
      },
      location: {
        type: "Point",
        coordinates: [coords.longitude, coords.latitude],
      },
      contact: {
        contactDetails: validatedContactDetails,
        mobile: mobile?.filter((num) => num.trim()) || [],
        whatsapp: whatsapp?.filter((num) => num.trim()) || [],
        email: email?.filter((em) => em.trim()) || [],
      },
      businessTiming: {
        isOpen24Hours: businessData.businessTiming?.isOpen24Hours ?? false,
        daysOfWeek: businessData.businessTiming?.daysOfWeek || [],
        schedule: businessData.businessTiming?.schedule || {},
      },
      category: validCategories,
      subCategory: validSubCategories,
      businessLogo: businessLogo ? businessLogo.filename : undefined,
      photos: photos.map((photo) => photo.filename),
      userId: userId,
      claimed: !isAdmin,
      isAdmin: isAdmin,
    };

    console.log("New business data:", newBusinessData);

    // Create and save business
    const newBusiness = new Business(newBusinessData);
    const savedBusiness = await newBusiness.save();

    console.log("Saved business:", savedBusiness);

    // Attach business to user if userId is provided
    if (userId) {
      const user = await User.findById(userId);
      if (!user) {
        return res.status(400).json({ message: "User not found." });
      }
      user.businesses.push(savedBusiness._id);
      user.isSeller = true;
      await user.save();
    }

    res.status(201).json({
      success: true,
      message: "Business created successfully",
      business: savedBusiness,
      businessId: savedBusiness._id,
    });
  } catch (error) {
    console.error("Error creating business:", error);
    res.status(400).json({
      success: false,
      message: error._message || error.message || "Failed to create business",
      errors: error.errors,
    });
  }
};

exports.importBusinessFromCSV = async (req, res) => {
  if (!req.file) return res.status(400).json({ message: "CSV file required" });

  const filePath = req.file.path;
  const results = [];
  const errors = [];

  // Read CSV
  fs.createReadStream(filePath)
    .pipe(csv())
    .on("data", (data) => results.push(data))
    .on("end", async () => {
      try {
        let created = 0;
        let updated = 0;
        let skipped = 0;

        for (const row of results) {
          try {
            const {
              "Business Name": businessName,
              address,
              Website: website,
              Email: email,
              Phone: phone,
              Rating: ratingStr,
              Reviews: reviewsStr,
              Latitude: latStr,
              Longitude: lonStr,
              Category: rawCategory,
              Subcategory: rawSubCategory,
              Country: rowCountry // Check for explicit Country column
            } = row;

            if (!businessName || !address) {
              errors.push(
                `Missing required fields: ${businessName || "Unknown"}`
              );
              skipped++;
              continue;
            }

            const latitude = latStr ? parseFloat(latStr) : 0;
            const longitude = lonStr ? parseFloat(lonStr) : 0;
            const needsGeocoding = !latStr || !lonStr;
            const rating = parseFloat(ratingStr) || 0;
            const totalReviews = parseInt(reviewsStr) || 0;

            // Extract parts from address
            // Format: Street; Area; City; State; Pincode; [Country]
            const addressParts = address.split(";").map(p => p.trim());
            const len = addressParts.length;

            let streetName = addressParts[0] || "";
            let area = len > 4 ? addressParts[1] : "";
            let city = "Unknown City";
            let state = "Unknown State";
            let pincode = "000000";
            let country = rowCountry || "Unknown Country";

            if (len === 5) {
              // Street; Area; City; State; Pincode
              city = addressParts[2] || city;
              state = addressParts[3] || state;
              pincode = addressParts[4] || pincode;
            } else if (len >= 6) {
              // Street; Area; City; State; Pincode; Country
              city = addressParts[2] || city;
              state = addressParts[3] || state;
              pincode = addressParts[4] || pincode;
              country = rowCountry || addressParts[5] || country;
            } else if (len === 3) {
              // City; State; Country (Minimum fallback)
              city = addressParts[0];
              state = addressParts[1];
              country = rowCountry || addressParts[2];
            }

            // Clean phone
            const cleanedPhone = phone?.replace(/\D/g, "");
            const mobile = cleanedPhone ? [cleanedPhone] : [];

            // Find or create Category
            const categoryText = rawCategory ? rawCategory.replace("· ", "").trim() : "Uncategorized";
            let categoryObj = await Category.findOne({
              name: { $regex: new RegExp(`^${categoryText}$`, "i") },
            });

            if (!categoryObj) {
              categoryObj = await Category.create({ name: categoryText });
            }

            // Find or create SubCategory
            const subCategoryText = rawSubCategory ? rawSubCategory.trim() : categoryText;
            let subCategoryObj = await SubCategory.findOne({
              name: { $regex: new RegExp(`^${subCategoryText}$`, "i") },
              category: categoryObj._id
            });

            if (!subCategoryObj) {
              subCategoryObj = await SubCategory.create({
                name: subCategoryText,
                category: categoryObj._id,
              });
            }

            // Business already exists check
            
            let business = await Business.findOne({
              businessName: { $regex: new RegExp(`^${businessName}$`, "i") },
              "address.city": city,
              "address.streetName": streetName,
              "address.pincode": pincode
            });

            if (business) {
              // APPEND categories if new
              const newCatId = categoryObj._id.toString();
              const newSubCatId = subCategoryObj._id.toString();

              if (!business.category.includes(newCatId)) {
                business.category.push(newCatId);
              }
              if (!business.subCategory.includes(newSubCatId)) {
                business.subCategory.push(newSubCatId);
              }

              // Update other fields if better
              if (!business.website && website) business.website = website;
              if (!business.contact.email.length && email)
                business.contact.email = [email];
              if (!business.contact.mobile.length && mobile.length)
                business.contact.mobile = mobile;
              if (rating > business.rating) business.rating = rating;
              if (totalReviews > business.totalReviews)
                business.totalReviews = totalReviews;

              await business.save();
              updated++;
            } else {
              // CREATE NEW
              business = new Business({
                businessName,
                address: {
                  city,
                  state,
                  country,
                  area,
                  pincode,
                  streetName,
                },
                location: {
                  type: "Point",
                  coordinates: [longitude, latitude],
                },
                contact: {
                  mobile,
                  email: email ? [email] : [],
                  contactDetails: [
                    {
                      title: "Mr",
                      name: businessName,
                      mobileNumbers: mobile,
                      emails: email ? [email] : [],
                    },
                  ],
                },
                website,
                rating,
                totalReviews,
                category: [categoryObj._id],
                subCategory: [subCategoryObj._id],
                verified: false,
                claimed: false,
                isBlocked: false,
                profileCompletionScore: 70,
                needsGeocoding: needsGeocoding,
              });

              await business.save();

              if (needsGeocoding) {
                await addJob("geocoding-batch", { businessId: business._id });
              }

              created++;
            }
          } catch (err) {
            errors.push(
              `Error processing ${row["Business Name"] || "row"}: ${
                err.message
              }`
            );
            skipped++;
          }
        }

        // Delete uploaded file
        fs.unlinkSync(filePath);

        res.json({
          message: "Import completed",
          created,
          updated,
          skipped,
          errors,
        });
      } catch (err) {
        console.error("CSV Import error:", err);
        res.status(500).json({ message: "Import failed", error: err.message });
      }
    });
};

exports.downloadSampleCSV = async (req, res) => {
  try {
    const csvContent = [
      "Business Name,address,Website,Email,Phone,Category,Subcategory",
      'DigitalMitro,"123 Tech St;Salt Lake;Kolkata;West Bengal;700091",https://digitalmitro.com,info@digitalmitro.com,9876543210,Marketing Agency,Digital Marketing',
      'Urban Citations,"45 High St;Central;London;Greater London;WC1 1AA",https://urbancitations.com,contact@urbancitations.com,+44207123456,Business Service,Local Listing'
    ].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=sample_business_import.csv");
    res.status(200).send(csvContent);
  } catch (error) {
    console.error("Error generating sample CSV:", error);
    res.status(500).json({ message: "Failed to generate sample CSV" });
  }
};

///this api use combnie for admin and users
exports.getBusiness = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      search = "",
      country = "",
      verified,
      trust,
      claimed,
    } = req.query;

    // Validate pagination
    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.max(1, Number(limit));
    const skip = (pageNum - 1) * limitNum;

    // SMART COUNTRY MAPPING
    const countryMap = {
      UK: "United Kingdom",
      "United Kingdom": "United Kingdom",
      USA: "United States",
      "United States": "United States",
      US: "United States",
      India: "India",
    };

    let normalizedCountry = "";
    if (country) {
      const upperCountry = country.trim().toUpperCase();
      normalizedCountry =
        countryMap[upperCountry] || countryMap[country.trim()] || country;
    }

    // Build query
    let query = {};

    // Search query
    if (search) {
      query.$or = [
        { businessName: { $regex: search, $options: "i" } },
        { "address.city": { $regex: search, $options: "i" } },
        { "address.area": { $regex: search, $options: "i" } },
        { "contact.email": { $regex: search, $options: "i" } },
        { "contact.mobile": { $regex: search, $options: "i" } },
        { "contact.contactDetails.name": { $regex: search, $options: "i" } },
        {
          "contact.contactDetails.mobileNumbers": {
            $regex: search,
            $options: "i",
          },
        },
        {
          "contact.contactDetails.whatsappNumbers": {
            $regex: search,
            $options: "i",
          },
        },
        { "contact.contactDetails.emails": { $regex: search, $options: "i" } },
      ];
    }

    // Country filter (Smart Match)
    if (normalizedCountry) {
      query["address.country"] = {
        $regex: new RegExp(`^${normalizedCountry}$`, "i"),
      };
    }

    // Status filters
    if (verified !== undefined) query.verified = verified === "true";
    if (trust !== undefined) query.trust = trust === "true";
    if (claimed !== undefined) query.claimed = claimed === "true";

    console.log("Final Query:", query);

    // Fetch businesses
    const businesses = await Business.find(query)
      .select(
        "businessName address contact businessTiming verified trust claimed isBlocked subscriptionActive _id rating totalReviews businessLogo photos"
      )
      .skip(skip)
      .limit(limitNum)
      .lean();

    const total = await Business.countDocuments(query);

    res.status(200).json({
      businesses,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum),
      currentPage: pageNum,
    });
  } catch (error) {
    console.error("Error fetching businesses:", error.message);
    res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};

exports.getBusinessById = async (req, res) => {
  try {
    const { id } = req.params;

    // Fetch business with populated fields
    const business = await Business.findById(id)
      .populate("category")
      .populate("subCategory")
      .lean();

    if (!business) {
      return res.status(404).json({
        success: false,
        message: "Business not found",
      });
    }

    const now = new Date();

    // REAL-TIME ENQUIRY COUNT
    const enquiryCount = await Enquiry.countDocuments({
      businessId: id,
      // status: "pending", // Remove if you want total enquiries
    });

    // FETCH ACTIVE OFFERS (Not expired)
    const activeOffers = await Offer.find({
      businessId: id,
      expirationDate: { $gte: now },
    })
      .populate("categoryId", "name")
      .populate("subCategoryId", "name")
      .sort({ createdAt: -1 });

    // Add readable service name
    const offersWithService = activeOffers.map((offer) => ({
      ...offer.toObject(),
      serviceName:
        offer.subCategoryId?.name || offer.categoryId?.name || "All Services",
    }));

    // Calculate profile completion score
    const criteria = {
      businessName: { weight: 10, check: !!business.businessName },
      address: {
        weight: 15,
        check:
          business.address &&
          Object.keys(business.address).some((key) => !!business.address[key]),
      },
      contact: {
        weight: 15,
        check:
          business.contact &&
          (business.contact.mobile?.length ||
            business.contact.email?.length ||
            business.contact.contactDetails?.length),
      },
      businessTiming: {
        weight: 10,
        check:
          business.businessTiming &&
          (business.businessTiming.isOpen24Hours ||
            business.businessTiming.daysOfWeek?.length ||
            Object.keys(business.businessTiming.schedule || {}).length),
      },
      kyc: {
        weight: 10,
        check: business.kyc && business.kyc.status !== "pending",
      },
      category: {
        weight: 10,
        check: business.category && business.category.length > 0,
      },
      subCategory: {
        weight: 5,
        check: business.subCategory && business.subCategory.length > 0,
      },
      photos: {
        weight: 5,
        check: business.photos && business.photos.length > 0,
      },
      socialLinks: {
        weight: 5,
        check:
          business.socialLinks && Object.keys(business.socialLinks).length > 0,
      },
      website: { weight: 5, check: !!business.website },
      videoUrl: { weight: 5, check: !!business.videoUrl },
      businessSummary: { weight: 5, check: !!business.businessSummary },
      yearsOfEstablishment: {
        weight: 5,
        check: business.yearsOfEstablishment > 0,
      },
    };

    const totalWeight = Object.values(criteria).reduce(
      (sum, { weight }) => sum + weight,
      0
    );
    const completedWeight = Object.values(criteria).reduce(
      (sum, { weight, check }) => sum + (check ? weight : 0),
      0
    );
    const profileCompletionScore = Math.round(
      (completedWeight / totalWeight) * 100
    );

    // Update business document
    const updatedBusiness = await Business.findByIdAndUpdate(
      id,
      {
        $set: {
          profileCompletionScore,
          enquiryCount,
          offerCount: offersWithService.length, // ← NEW: Save count in business
        },
      },
      { new: true, runValidators: true }
    )
      .populate("category")
      .populate("subCategory");

    // Pending actions
    const pendingActions = Object.entries(criteria)
      .filter(([, { check }]) => !check)
      .map(([key]) => {
        const actions = {
          businessName: "Add Business Name",
          address: "Complete Address Details",
          contact: "Add Contact Information",
          businessTiming: "Set Business Timings",
          kyc: "Complete KYC Verification",
          category: "Add Business Category",
          subCategory: "Add Sub-Category",
          photos: "Upload Photos",
          socialLinks: "Add Social Links",
          website: "Add Website",
          videoUrl: "Add Video",
          businessSummary: "Add Business Summary",
          yearsOfEstablishment: "Add Years of Establishment",
        };
        return actions[key] || "Complete Additional Info";
      });

    // FINAL RESPONSE
    return res.json({
      success: true,
      message: "Business fetched successfully",
      business: {
        ...updatedBusiness.toObject({ flattenMaps: true }),
        offerCount: offersWithService.length,
        offers: offersWithService, // ← Full offer details for frontend
      },
      enquiryCount,
      pendingActions,
    });
  } catch (err) {
    console.error("Error in getBusinessById:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: err.message,
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
        message:
          "Business ID and valid contact object with contactDetails array are required",
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
      title: detail.title || "Mr",
      name: detail.name?.trim() || "",
      designation: detail.designation?.trim() || "",
      mobileNumbers: detail.mobileNumbers?.filter((num) => num?.trim()) || [""],
      whatsappNumbers: detail.whatsappNumbers?.filter((num) => num?.trim()) || [
        "",
      ],
      emails: detail.emails?.filter(
        (email) => email?.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      ) || [""],
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
            {
              "contact.contactDetails.mobileNumbers": {
                $regex: query,
                $options: "i",
              },
            },
            {
              "contact.contactDetails.whatsappNumbers": {
                $regex: query,
                $options: "i",
              },
            },
            {
              "contact.contactDetails.emails": { $regex: query, $options: "i" },
            },
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
      if (user.businesses.length === 0) {
        user.isSeller = false;
      }
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

    // Define allowed fields
    const allowedFields = [
      "businessName",
      "contact",
      "address",
      "businessSummary",
      "businessTiming",
      "isOpen24Hours",
      "yearsOfEstablishment",
      "photos",
      "verified",
      "trust",
      "claimed",
      "kyc", // Added to allow KYC updates
    ];

    const updates = {};
    for (const field of allowedFields) {
      if (parsedData.hasOwnProperty(field)) {
        updates[field] = parsedData[field];
      }
    }

    // Handle contact.contactDetails specifically
    if (
      parsedData.contact?.contactDetails &&
      Array.isArray(parsedData.contact.contactDetails)
    ) {
      updates.contact = updates.contact || {};
      updates.contact.contactDetails = parsedData.contact.contactDetails.map(
        (contact) => ({
          title: contact.title || "Mr",
          name: contact.name || "",
          designation: contact.designation || "",
          mobileNumbers: contact.mobileNumbers?.filter((num) => num.trim()) || [
            "",
          ],
          whatsappNumbers: contact.whatsappNumbers?.filter((num) =>
            num.trim()
          ) || [""],
          emails: contact.emails?.filter((email) => email.trim()) || [""],
        })
      );
      // Sync top-level contact fields if provided
      if (parsedData.contact.mobile)
        updates.contact.mobile = parsedData.contact.mobile.filter((num) =>
          num.trim()
        );
      if (parsedData.contact.whatsapp)
        updates.contact.whatsapp = parsedData.contact.whatsapp.filter((num) =>
          num.trim()
        );
      if (parsedData.contact.email)
        updates.contact.email = parsedData.contact.email.filter((email) =>
          email.trim()
        );
    }

    // Handle KYC updates
    if (updates.kyc) {
      updates.kyc = {
        ...business.kyc, // Preserve existing KYC fields
        ...updates.kyc, // Apply provided updates
        // Set verifiedAt based on status
        verifiedAt:
          updates.kyc.status === "verified"
            ? new Date()
            : updates.kyc.status === "rejected" ||
              updates.kyc.status === "pending"
            ? null
            : business.kyc.verifiedAt,
      };
      // Validate KYC status
      if (
        updates.kyc.status &&
        !["pending", "verified", "rejected"].includes(updates.kyc.status)
      ) {
        return res.status(400).json({ message: "Invalid KYC status" });
      }
      // Ensure documents is a Map
      if (updates.kyc.documents) {
        updates.kyc.documents = new Map(Object.entries(updates.kyc.documents));
      }
    }

    // Handle uploaded businessLogo
    if (req.files?.businessLogo?.[0]) {
      const logoFileName = path.basename(req.files.businessLogo[0].path);
      updates.businessLogo = logoFileName;
    }

    // Handle uploaded photos
    if (req.files?.photos) {
      const photoFileNames = req.files.photos.map((file) =>
        path.basename(file.path)
      );
      updates.photos = [
        ...(updates.photos || business.photos || []),
        ...photoFileNames,
      ];
    }

    updates.updatedAt = new Date();

    const updatedBusiness = await Business.findByIdAndUpdate(
      businessId,
      updates,
      {
        new: true,
        runValidators: true,
      }
    );

    // Send KYC notification if status changed and is not pending
    if (
      updates.kyc &&
      updates.kyc.status &&
      updates.kyc.status !== "pending" &&
      updates.kyc.status !== business.kyc?.status
    ) {
      await addJob("kyc-email", {
        businessId: updatedBusiness._id,
        status: updates.kyc.status,
        rejectionReason: updates.kyc.rejectionReason,
      });
    }

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
      return res.status(400).json({ message: "No status updates provided" });
    }

    const business = await Business.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true }
    );
    if (!business) {
      return res.status(404).json({ message: "Business not found" });
    }

    res
      .status(200)
      .json({ message: "Business status updated successfully", business });
  } catch (error) {
    console.error("Error updating business status:", error.message);
    res
      .status(500)
      .json({ message: "Internal server error", error: error.message });
  }
};

exports.updateSocialInfo = async (req, res) => {
  const { businessId } = req.params;
  console.log("Request body:", req.body); // Debug log
  const { website, videoUrl: providedVideoUrl } = req.body;

  let socialLinks = req.body.socialLinks
    ? JSON.parse(req.body.socialLinks)
    : {};

  if (!mongoose.Types.ObjectId.isValid(businessId)) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid business ID" });
  }

  try {
    const business = await Business.findById(businessId);
    if (!business) {
      return res
        .status(404)
        .json({ success: false, message: "Business not found" });
    }

    const updateData = {};
    if (socialLinks && typeof socialLinks === "object") {
      updateData.socialLinks = socialLinks;
    } else {
      return res
        .status(400)
        .json({ success: false, message: "socialLinks must be an object" });
    }

    if (
      website &&
      !validator.isURL(website, {
        protocols: ["http", "https"],
        require_protocol: true,
      })
    ) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid website URL" });
    }
    if (website) updateData.website = website;

    let finalVideoUrl = providedVideoUrl;
    if (req.file) {
      // For S3, use the full S3 URL
      finalVideoUrl = `https://${process.env.AWS_BUCKET_NAME}.s3.amazonaws.com/${req.file.key}`;
    } else if (
      providedVideoUrl &&
      !validator.isURL(providedVideoUrl, {
        protocols: ["http", "https"],
        require_protocol: true,
      })
    ) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid video URL" });
    }
    if (finalVideoUrl) updateData.videoUrl = finalVideoUrl;

    const updatedBusiness = await Business.findByIdAndUpdate(
      businessId,
      { $set: updateData },
      { new: true, runValidators: true }
    );

    if (!updatedBusiness) {
      return res
        .status(500)
        .json({ success: false, message: "Failed to update business" });
    }

    res.status(200).json({
      success: true,
      message: "Social information updated successfully",
      business: updatedBusiness,
    });
  } catch (err) {
    console.error("Error updating social info:", err);
    res.status(500).json({
      success: false,
      message: "Server error while updating social information",
      error: err.message,
    });
  }
};

exports.calculateProfileCompletionScore = async (req, res) => {
  const { businessId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(businessId)) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid business ID" });
  }

  try {
    const business = await Business.findById(businessId);
    if (!business) {
      return res
        .status(404)
        .json({ success: false, message: "Business not found" });
    }

    // Define completion criteria and weights (total = 100%)
    const criteria = {
      businessName: { weight: 10, check: !!business.businessName },
      address: {
        weight: 15,
        check:
          business.address &&
          Object.keys(business.address).some((key) => !!business.address[key]),
      },
      contact: {
        weight: 15,
        check:
          business.contact &&
          (business.contact.mobile.length ||
            business.contact.email.length ||
            business.contact.contactDetails.length),
      },
      businessTiming: {
        weight: 10,
        check:
          business.businessTiming &&
          (business.businessTiming.isOpen24Hours ||
            business.businessTiming.daysOfWeek.length ||
            Object.keys(business.businessTiming.schedule || {}).length),
      },
      kyc: {
        weight: 10,
        check: business.kyc && business.kyc.status !== "pending",
      },
      category: {
        weight: 10,
        check: business.category && business.category.length > 0,
      },
      subCategory: {
        weight: 5,
        check: business.subCategory && business.subCategory.length > 0,
      },
      photos: {
        weight: 5,
        check: business.photos && business.photos.length > 0,
      },
      socialLinks: {
        weight: 5,
        check:
          business.socialLinks && Object.keys(business.socialLinks).length > 0,
      },
      website: { weight: 5, check: !!business.website },
      videoUrl: { weight: 5, check: !!business.videoUrl },
      businessSummary: { weight: 5, check: !!business.businessSummary },
      yearsOfEstablishment: {
        weight: 5,
        check: business.yearsOfEstablishment > 0,
      },
    };

    // Calculate total possible score
    const totalWeight = Object.values(criteria).reduce(
      (sum, { weight }) => sum + weight,
      0
    ); // Should be 100

    // Calculate completed score
    const completedWeight = Object.values(criteria).reduce(
      (sum, { weight, check }) => sum + (check ? weight : 0),
      0
    );

    // Calculate percentage
    const profileCompletionScore = Math.round(
      (completedWeight / totalWeight) * 100
    );

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
          case "businessName":
            return "Add Business Name";
          case "address":
            return "Complete Address Details";
          case "contact":
            return "Add Contact Information";
          case "businessTiming":
            return "Set Business Timings";
          case "kyc":
            return "Complete KYC Verification";
          case "category":
            return "Add Business Category";
          case "subCategory":
            return "Add Sub-Category";
          case "photos":
            return "Upload Photos";
          case "socialLinks":
            return "Add Social Links";
          case "website":
            return "Add Website";
          case "videoUrl":
            return "Add Video";
          case "businessSummary":
            return "Add Business Summary";
          case "yearsOfEstablishment":
            return "Add Years of Establishment";
          default:
            return "Complete Additional Info";
        }
      });

    res.status(200).json({
      success: true,
      message: "Profile completion score calculated successfully",
      business: updatedBusiness,
      pendingActions,
    });
  } catch (err) {
    console.error("Error calculating profile completion score:", err);
    res.status(500).json({
      success: false,
      message: "Server error while calculating profile completion score",
      error: err.message,
    });
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
        status: "pending",
      };
    }

    // Handle uploaded KYC documents with their types
    if (req.files && req.files.length > 0) {
      const requiredDocs = {
        USA: [
          "Certificate of Incorporation",
          "Employer Identification Number (EIN)",
          "Proof of Identity (Passport/Driver's License)",
          "Proof of Address (Utility Bill/Bank Statement)",
          "Business License/Permit",
        ],
        Europe: [
          "Articles of Association",
          "Proof of Identity (Passport/ID Card)",
          "Proof of Address",
          "Notarized Registration Documents",
          "Tax ID/VAT Number",
        ],
        India: [
          "PAN Card",
          "Aadhaar Card",
          "Director Identification Number (DIN)",
          "Digital Signature Certificate (DSC)",
          "Memorandum of Association (MoA)",
          "Articles of Association (AoA)",
          "Proof of Registered Office (Utility Bill/Lease)",
        ],
      };
      const countryDocs = requiredDocs[parsedData.kyc.country] || [];
      req.files.forEach((file, index) => {
        if (index < countryDocs.length) {
          updates.kyc.documents[countryDocs[index]] = path.basename(file.path);
        }
      });
    }

    const updatedBusiness = await Business.findByIdAndUpdate(
      businessId,
      updates,
      { new: true }
    );

    return res.status(200).json({
      message: "KYC documents updated successfully",
      business: updatedBusiness,
    });
  } catch (err) {
    console.error("Error updating KYC:", err);
    return res
      .status(500)
      .json({ message: "Failed to update KYC", error: err.message });
  }
};

exports.deleteKYCDocument = async (req, res) => {
  try {
    const { id } = req.params;
    const { docName } = req.body;

    if (!id || !docName) {
      return res
        .status(400)
        .json({ message: "Business ID and document name are required" });
    }

    const business = await Business.findById(id);
    if (!business) {
      return res.status(404).json({ message: "Business not found" });
    }

    if (
      business.kyc &&
      business.kyc.documents &&
      business.kyc.documents.has(docName)
    ) {
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
    return res
      .status(500)
      .json({ message: "Failed to delete document", error: err.message });
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
      subCategory,
      isOpenNow,
      isTopRated,
      isVerified,
      hasDeals,
      isTrusted,
      sortBy,
      type,
      lat,
      lon,
      radius = 100,
    } = req.query;

    // Validation
    if (!lat || !lon) {
      return res.status(400).json({
        success: false,
        message: "lat and lon are required for location-based search",
      });
    }

    const skip = (Number(page) - 1) * Number(limit);
    const userLocation = [Number(lon), Number(lat)];
    const maxDistance = Number(radius) * 1000;
    const now = new Date();

    // Base Filters
    const postGeoFilters = {
      isBlocked: false,

      // Category (safe)
      ...(category && {
        category: {
          $in: toObjectIdArray(category),
        },
      }),

      // SUBCATEGORY — Safe handling
      ...(subCategory &&
        toObjectIdArray(subCategory).length > 0 && {
          subCategory: {
            $in: toObjectIdArray(subCategory),
          },
        }),

      ...(isVerified === "true" && { verified: true }),
      ...(isTrusted === "true" && { trust: true }),
      ...(type && { type: { $in: type.split(",") } }),
      ...(isTopRated === "true" && { rating: { $gte: 4.5 } }),
    };

    // isOpenNow Logic
    if (isOpenNow === "true") {
      const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const today = days[now.getDay()];
      const currentTime = `${now.getHours().toString().padStart(2, "0")}:${now
        .getMinutes()
        .toString()
        .padStart(2, "0")}`;

      postGeoFilters.$or = [
        { "businessTiming.isOpen24Hours": true },
        {
          $expr: {
            $gt: [
              {
                $size: {
                  $filter: {
                    input: {
                      $ifNull: [`$businessTiming.schedule.${today}`, []],
                    },
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
              0,
            ],
          },
        },
      ];
    }

    // Sorting
    const userSort = {};
    if (sortBy === "A-Z") userSort.businessName = 1;
    else if (sortBy === "Z-A") userSort.businessName = -1;
    else if (sortBy === "Newest") userSort.createdAt = -1;
    else if (sortBy === "Oldest") userSort.createdAt = 1;

    // Main Aggregation Pipeline
    const pipeline = [
      {
        $geoNear: {
          near: { type: "Point", coordinates: userLocation },
          distanceField: "distance",
          maxDistance,
          spherical: true,
        },
      },
      { $match: postGeoFilters },

      // Count Active Offers
      {
        $lookup: {
          from: "offers",
          let: { businessId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$businessId", "$$businessId"] },
                expirationDate: { $gte: now },
              },
            },
            { $count: "count" },
          ],
          as: "activeOffers",
        },
      },
      {
        $addFields: {
          offerCount: {
            $cond: {
              if: { $gt: [{ $size: "$activeOffers" }, 0] },
              then: { $arrayElemAt: ["$activeOffers.count", 0] },
              else: 0,
            },
          },
        },
      },
      { $unset: "activeOffers" },

      // Filter businesses with deals (if hasDeals=true)
      ...(hasDeals === "true" ? [{ $match: { offerCount: { $gt: 0 } } }] : []),

      // Convert distance to KM
      {
        $addFields: {
          distance: { $round: [{ $divide: ["$distance", 1000] }, 1] },
        },
      },

      // Final Sort: Distance first, then user choice
      {
        $sort: {
          distance: 1,
          ...userSort,
        },
      },

      { $skip: skip },
      { $limit: Number(limit) },

      // === POPULATE CATEGORY NAMES (FIXED) ===
      {
        $lookup: {
          from: "categories",
          localField: "category",
          foreignField: "_id",
          as: "categoryDetails",
        },
      },
      {
        $addFields: {
          category: {
            $map: {
              input: "$category",
              as: "catId",
              in: {
                $let: {
                  vars: {
                    catDetail: {
                      $arrayElemAt: [
                        {
                          $filter: {
                            input: "$categoryDetails",
                            cond: { $eq: ["$$this._id", "$$catId"] },
                          },
                        },
                        0,
                      ],
                    },
                  },
                  in: {
                    _id: "$$catId",
                    name: { $ifNull: ["$$catDetail.name", "Unknown Category"] },
                  },
                },
              },
            },
          },
        },
      },
      { $unset: "categoryDetails" },

      // === POPULATE SUBCATEGORY NAMES (FIXED) ===
      {
        $lookup: {
          from: "subcategories",
          localField: "subCategory",
          foreignField: "_id",
          as: "subCategoryDetails",
        },
      },
      {
        $addFields: {
          subCategory: {
            $map: {
              input: "$subCategory",
              as: "subId",
              in: {
                $let: {
                  vars: {
                    subDetail: {
                      $arrayElemAt: [
                        {
                          $filter: {
                            input: "$subCategoryDetails",
                            cond: { $eq: ["$$this._id", "$$subId"] },
                          },
                        },
                        0,
                      ],
                    },
                  },
                  in: {
                    _id: "$$subId",
                    name: {
                      $ifNull: ["$$subDetail.name", "Unknown Subcategory"],
                    },
                  },
                },
              },
            },
          },
        },
      },
      { $unset: "subCategoryDetails" },
    ];

    const businesses = await Business.aggregate(pipeline);

    // Total Count Pipeline
    const countPipeline = pipeline
      .filter((stage) => !["$skip", "$limit"].includes(Object.keys(stage)[0]))
      .concat([{ $count: "total" }]);

    const totalResult = await Business.aggregate(countPipeline);
    const total = totalResult[0]?.total || 0;

    return res.status(200).json({
      success: true,
      page: Number(page),
      limit: Number(limit),
      total,
      businesses: businesses.map((biz) => ({
        ...biz,
        offerCount: biz.offerCount || 0,
      })),
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
