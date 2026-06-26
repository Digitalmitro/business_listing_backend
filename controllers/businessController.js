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
const ExcelJS = require("exceljs");
const XLSX = require("xlsx");
const fs = require("fs");
const { addJob } = require("../utils/queue");
const { notifyAdmins } = require("../helpers/notificationHelper");

const VALID_COUNTRIES = [
  "Afghanistan", "Albania", "Algeria", "Andorra", "Angola", "Antigua and Barbuda", "Argentina", "Armenia", "Australia", "Austria", "Azerbaijan",
  "Bahamas", "Bahrain", "Bangladesh", "Barbados", "Belarus", "Belgium", "Belize", "Benin", "Bhutan", "Bolivia", "Bosnia and Herzegovina", "Botswana", "Brazil", "Brunei", "Bulgaria", "Burkina Faso", "Burundi",
  "Cabo Verde", "Cambodia", "Cameroon", "Canada", "Central African Republic", "Chad", "Chile", "China", "Colombia", "Comoros", "Congo", "Costa Rica", "Croatia", "Cuba", "Cyprus", "Czech Republic",
  "Denmark", "Djibouti", "Dominica", "Dominican Republic",
  "Ecuador", "Egypt", "El Salvador", "Equatorial Guinea", "Eritrea", "Estonia", "Eswatini", "Ethiopia",
  "Fiji", "Finland", "France",
  "Gabon", "Gambia", "Georgia", "Germany", "Ghana", "Greece", "Grenada", "Guatemala", "Guinea", "Guinea-Bissau", "Guyana",
  "Haiti", "Honduras", "Hungary",
  "Iceland", "India", "Indonesia", "Iran", "Iraq", "Ireland", "Israel", "Italy", "Ivory Coast",
  "Jamaica", "Japan", "Jordan",
  "Kazakhstan", "Kenya", "Kiribati", "Kuwait", "Kyrgyzstan",
  "Laos", "Latvia", "Lebanon", "Lesotho", "Liberia", "Libya", "Liechtenstein", "Lithuania", "Luxembourg",
  "Madagascar", "Malawi", "Malaysia", "Maldives", "Mali", "Malta", "Marshall Islands", "Mauritania", "Mauritius", "Mexico", "Micronesia", "Moldova", "Monaco", "Mongolia", "Montenegro", "Morocco", "Mozambique", "Myanmar",
  "Namibia", "Nauru", "Nepal", "Netherlands", "New Zealand", "Nicaragua", "Niger", "Nigeria", "North Korea", "North Macedonia", "Norway",
  "Oman",
  "Pakistan", "Palau", "Palestine", "Panama", "Papua New Guinea", "Paraguay", "Peru", "Philippines", "Poland", "Portugal",
  "Qatar",
  "Romania", "Russia", "Rwanda",
  "Saint Kitts and Nevis", "Saint Lucia", "Saint Vincent and the Grenadines", "Samoa", "San Marino", "Sao Tome and Principe", "Saudi Arabia", "Senegal", "Serbia", "Seychelles", "Sierra Leone", "Singapore", "Slovakia", "Slovenia", "Solomon Islands", "Somalia", "South Africa", "South Korea", "South Sudan", "Spain", "Sri Lanka", "Sudan", "Suriname", "Sweden", "Switzerland", "Syria",
  "Taiwan", "Tajikistan", "Tanzania", "Thailand", "Timor-Leste", "Togo", "Tonga", "Trinidad and Tobago", "Tunisia", "Turkey", "Turkmenistan", "Tuvalu",
  "Uganda", "Ukraine", "United Arab Emirates", "United Kingdom", "United States", "Uruguay", "Uzbekistan",
  "Vanuatu", "Vatican City", "Venezuela", "Vietnam",
  "Yemen",
  "Zambia", "Zimbabwe"
];

const VALID_COUNTRIES_MAP = new Map(VALID_COUNTRIES.map(c => [c.toLowerCase(), c]));

// Helper to normalize country names
const normalizeCountry = (c) => {
  if (!c || typeof c !== "string") return "Unknown Country";
  const trimmed = c.trim();
  const upper = trimmed.toUpperCase();
  const map = {
    "USA": "United States",
    "US": "United States",
    "UNITED STATES": "United States",
    "UK": "United Kingdom",
    "UAE": "United Arab Emirates",
    "CANADA": "Canada",
    "INDIA": "India"
  };
  const mappedCountry = map[upper] || trimmed;
  const standardName = VALID_COUNTRIES_MAP.get(mappedCountry.toLowerCase());
  return standardName || mappedCountry;
};

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

    const isAdmin = ["admin", "super-admin"].includes(req.user?.role);
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

    // Removed console.logs from hot path
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
        state: businessData.address?.state,
        country: normalizeCountry(businessData.address?.country),
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

    // Notify Admins about new business
    await notifyAdmins({
      title: "New Business Listed",
      description: `${savedBusiness.businessName} has been listed on the platform.`,
      link: `/view-business/${savedBusiness._id}`,
      category: "business",
    });

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
  if (!req.file) return res.status(400).json({ message: "File is required. Upload a CSV or Excel (.xlsx) file." });

  const filePath = req.file.path;
  const fileExt = path.extname(req.file.originalname).toLowerCase();
  const CHUNK_SIZE = 500;
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let skipped = 0;
  const errors = [];
  const warnings = [];
  const importKeys = new Set();
  const affectedCountries = new Set();
  const selectedCountry = req.body?.country ? normalizeCountry(req.body.country) : "";

  console.log(`[BulkImport] Starting import: file=${req.file.originalname}, ext=${fileExt}, size=${req.file.size}`);
  // Validate file type
  if (![".csv", ".xlsx"].includes(fileExt)) {
    fs.unlinkSync(filePath);
    return res.status(400).json({ message: "Unsupported file type. Upload a .csv or .xlsx file. Save legacy .xls files as .xlsx first." });
  }

  // Pre-cache Categories and Subcategories to minimize DB queries
  const categoryCache = new Map();
  const subCategoryCache = new Map();

  const getCategory = async (name) => {
    const key = name.toLowerCase().trim();
    if (categoryCache.has(key)) return categoryCache.get(key);
    let cat = await Category.findOne({ name: { $regex: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") } });
    if (!cat) cat = await Category.create({ name });
    categoryCache.set(key, cat);
    return cat;
  };

  const getSubCategory = async (name, categoryId) => {
    const key = `${categoryId}:${name.toLowerCase().trim()}`;
    if (subCategoryCache.has(key)) return subCategoryCache.get(key);
    let sub = await SubCategory.findOne({
      name: { $regex: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") },
      category: categoryId,
    });
    if (!sub) sub = await SubCategory.create({ name, category: categoryId });
    subCategoryCache.set(key, sub);
    return sub;
  };

  // CSV files exported by Excel commonly contain a UTF-8 BOM and headers vary
  // between providers (for example "Business Name", "business_name", etc.).
  // Normalize the keys once so those harmless differences do not skip every row.
  const normalizeHeader = (header) => String(header || "")
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

  const createRowReader = (row) => {
    const values = new Map();
    Object.entries(row || {}).forEach(([header, value]) => {
      values.set(normalizeHeader(header), value);
    });

    return {
      get(...aliases) {
        for (const alias of aliases) {
          const key = normalizeHeader(alias);
          if (values.has(key)) {
            const value = values.get(key);
            return value === null || value === undefined ? "" : String(value).trim();
          }
        }
        return "";
      },
      has(...aliases) {
        return aliases.some((alias) => values.has(normalizeHeader(alias)));
      },
    };
  };

  const normalizeIdentityPart = (value) => String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

  const getBusinessImportKey = (business) => [
    normalizeIdentityPart(business.businessName),
    normalizeIdentityPart(business.address?.city),
    normalizeIdentityPart(business.address?.pincode).replace(/\s+/g, ""),
    normalizeIdentityPart(normalizeCountry(business.address?.country)),
  ].join("|");

  // Normalize a raw row object (from CSV or Excel) into a standard shape.
  // Supports two layouts:
  //   Layout A (combined address): "Business Name", "address" (semicolon-separated), ...
  //   Layout B (flat columns):     "business_name", "address", "city", "state", "country", "postal_code", ...
  const normalizeRow = (row) => {
    const reader = createRowReader(row);

    // ── Business name: try multiple common header variants ──
    const businessName = reader.get("Business Name", "businessName", "business_name", "Name", "Company Name");

    // ── Contact fields ──
    const website = reader.get("Website", "Website URL", "URL");
    const email = reader.get("Email", "Email Address");
    const phone = reader.get("Phone", "Mobile", "Phone Number", "Mobile Number");
    const ratingStr = reader.get("Rating") || "0";
    const reviewsStr = reader.get("Reviews", "Review Count", "Total Reviews") || "0";
    const latStr = reader.get("Latitude", "Lat");
    const lonStr = reader.get("Longitude", "Lng", "Lon", "Long");
    const parsedLatitude = Number.parseFloat(latStr);
    const parsedLongitude = Number.parseFloat(lonStr);
    const hasValidCoordinates = Number.isFinite(parsedLatitude) &&
      Number.isFinite(parsedLongitude) &&
      parsedLatitude >= -90 && parsedLatitude <= 90 &&
      parsedLongitude >= -180 && parsedLongitude <= 180;

    // ── Category ──
    const rawCategory = (reader.get("Category") || "Uncategorized").replace("· ", "").trim();
    const rawSubCategory = reader.get("Subcategory", "Sub Category") || rawCategory;

    // ── Extra fields ──
    const businessSummary = reader.get("Description", "Business Summary");
    const ownerName = reader.get("Owner Name");

    if (!businessName) return null;

    // Older generated Excel samples included an instruction row below the
    // headers. Ignore it rather than importing it as a real business.
    if (/^required\s*:/i.test(businessName)) return { ignored: true };

    // ── Address resolution: detect Layout A vs B ──
    // Layout B detected when any of these separate-column headers are present
    const hasCity = reader.has("City");
    const hasState = reader.has("State");
    const hasPostal = reader.has("Postal Code", "Pincode", "Zip Code", "ZIP");
    const isFlatLayout = hasCity || hasState || hasPostal;

    let streetName = "";
    let area       = "";
    let city       = "Unknown City";
    let state      = "Unknown State";
    let pincode    = "000000";
    let country    = "Unknown Country";

    if (isFlatLayout) {
      // Layout B: separate columns
      streetName = reader.get("Address", "Street", "Street Address");
      area = reader.get("Area", "Locality");
      city = reader.get("City") || "Unknown City";
      state = reader.get("State", "Province") || "Unknown State";
      pincode = reader.get("Postal Code", "Pincode", "Zip Code", "ZIP") || "000000";
      country = normalizeCountry(reader.get("Country") || selectedCountry || "Unknown Country");
    } else {
      // Layout A: semicolon-delimited combined address string
      const rawAddress = reader.get("Address", "Street Address");
      if (!rawAddress) return null; // Layout A requires an address string
      const rowCountry = reader.get("Country");

      const parts = rawAddress.split(";").map((p) => p.trim());
      const len = parts.length;
      streetName = parts[0] || "";
      country = normalizeCountry(rowCountry || parts[5] || selectedCountry || "Unknown Country");

      if (len >= 5) {
        area    = parts[1]; city  = parts[2]; state = parts[3]; pincode = parts[4];
      } else if (len === 4) {
        city    = parts[1]; state = parts[2];
        if (rowCountry || selectedCountry) {
          pincode = parts[3] || pincode;
          country = normalizeCountry(rowCountry || selectedCountry);
        } else {
          country = normalizeCountry(parts[3] || country);
        }
      } else if (len === 3) {
        if (rowCountry || selectedCountry) {
          city = parts[1] || parts[0]; state = parts[2] || state;
          country = normalizeCountry(rowCountry || selectedCountry);
        } else {
          city = parts[0]; state = parts[1];
          country = normalizeCountry(parts[2] || country);
        }
      }
    }

    // Require at minimum a business name and a resolvable city (or street)
    if (!businessName || (city === "Unknown City" && !streetName)) return null;

    return {
      businessName,
      address: { city, state, country, area, pincode, streetName },
      website,
      email,
      phone,
      rating: parseFloat(ratingStr) || 0,
      totalReviews: parseInt(reviewsStr) || 0,
      latitude: hasValidCoordinates ? parsedLatitude : 0,
      longitude: hasValidCoordinates ? parsedLongitude : 0,
      rawCategory:    rawCategory    || "Uncategorized",
      rawSubCategory: rawSubCategory || rawCategory || "Uncategorized",
      needsGeocoding: !hasValidCoordinates,
      businessSummary,
      ownerName,
    };
  };

  const processChunk = async (chunk) => {
    const bulkOps = [];
    const bulkOpTypes = [];
    const bulkOpCountries = [];
    const geocodingCandidates = [];

    // 1. Normalize rows
    const normalizedRows = [];
    for (const row of chunk) {
      try {
        const normalized = normalizeRow(row);
        if (!normalized) {
          skipped++;
          const reader = createRowReader(row);
          const rowId = reader.get("Business Name", "Name", "Company Name") || JSON.stringify(row).slice(0, 60);
          const reason = !reader.get("Business Name", "Name", "Company Name")
            ? "missing business name"
            : "missing address / city";
          const msg = `Row skipped (${reason}): ${rowId}`;
          errors.push(msg);
          console.warn(`[BulkImport] ${msg}`);
          continue;
        }

        if (normalized.ignored) continue;

        const importKey = getBusinessImportKey(normalized);
        if (importKeys.has(importKey)) {
          unchanged++;
          warnings.push(`Duplicate row in uploaded file: ${normalized.businessName}`);
          continue;
        }
        importKeys.add(importKey);
        normalizedRows.push(normalized);
      } catch (err) {
        skipped++;
        const msg = `Row skipped (error): ${err.message}`;
        errors.push(msg);
        console.warn(`[BulkImport] ${msg}`);
      }
    }

    if (normalizedRows.length === 0) return;

    // 2. Batch-resolve categories/subcategories
    try {
      const uniqueCatNames = [...new Set(normalizedRows.map((r) => r.rawCategory))];
      for (const name of uniqueCatNames) await getCategory(name);

      for (const r of normalizedRows) {
        const catObj = categoryCache.get(r.rawCategory.toLowerCase().trim());
        if (catObj) await getSubCategory(r.rawSubCategory, catObj._id);
      }
    } catch (err) {
      errors.push(`Category resolution error: ${err.message}`);
    }

    // 3. Batch-lookup existing businesses
    const businessNames = normalizedRows.map((r) => r.businessName);
    const existingBusinesses = await Business.find({ businessName: { $in: businessNames } })
      .collation({ locale: "en", strength: 2 })
      .lean();
    const existingMap = new Map();
    existingBusinesses.forEach((biz) => {
      existingMap.set(getBusinessImportKey(biz), biz);
    });

    // 4. Build bulk ops
    for (const row of normalizedRows) {
      try {
        const catObj = categoryCache.get(row.rawCategory.toLowerCase().trim());
        const subCatObj = subCategoryCache.get(`${catObj?._id}:${row.rawSubCategory.toLowerCase().trim()}`);

        if (!catObj) { skipped++; errors.push(`No category found for row: ${row.businessName}`); continue; }

        const lookupKey = getBusinessImportKey(row);
        const existing = existingMap.get(lookupKey);
        const cleanedPhone = row.phone?.replace(/\D/g, "");
        const mobile = cleanedPhone ? [cleanedPhone] : [];

        if (existing) {
          const set = {};
          const addToSet = {};
          const existingCategoryIds = (existing.category || []).map(String);
          const existingSubCategoryIds = (existing.subCategory || []).map(String);

          if (!existingCategoryIds.includes(String(catObj._id))) addToSet.category = catObj._id;
          if (subCatObj && !existingSubCategoryIds.includes(String(subCatObj._id))) {
            addToSet.subCategory = subCatObj._id;
          }
          if (!existing.website && row.website) set.website = row.website;
          if (!existing.contact?.email?.length && row.email) set["contact.email"] = [row.email];
          if (!existing.contact?.mobile?.length && mobile.length) set["contact.mobile"] = mobile;
          if (!existing.businessSummary && row.businessSummary) set.businessSummary = row.businessSummary;
          if (row.rating > (existing.rating || 0)) set.rating = row.rating;
          if (row.totalReviews > (existing.totalReviews || 0)) set.totalReviews = row.totalReviews;

          const existingCoordinates = existing.location?.coordinates || [];
          if (!row.needsGeocoding && (
            existing.needsGeocoding ||
            existingCoordinates.length !== 2 ||
            (existingCoordinates[0] === 0 && existingCoordinates[1] === 0)
          )) {
            set.location = { type: "Point", coordinates: [row.longitude, row.latitude] };
            set.needsGeocoding = false;
            set.geocodingError = null;
          }

          if (Object.keys(set).length === 0 && Object.keys(addToSet).length === 0) {
            unchanged++;
            continue;
          }

          set.updatedAt = new Date();
          const update = { $set: set };
          if (Object.keys(addToSet).length > 0) update.$addToSet = addToSet;

          bulkOps.push({ updateOne: { filter: { _id: existing._id }, update } });
          bulkOpTypes.push("update");
          bulkOpCountries.push(row.address.country);
          if (row.needsGeocoding) geocodingCandidates.push(existing._id);
        } else {
          const businessId = new mongoose.Types.ObjectId();
          bulkOps.push({
            insertOne: {
              document: {
                _id: businessId,
                businessName: row.businessName,
                address: row.address,
                location: { type: "Point", coordinates: [row.longitude, row.latitude] },
                contact: {
                  mobile,
                  email: row.email ? [row.email] : [],
                  contactDetails: [{
                    title: "Mr",
                    name: row.ownerName || row.businessName,
                    mobileNumbers: mobile,
                    emails: row.email ? [row.email] : [],
                  }],
                },
                website: row.website,
                rating: row.rating,
                totalReviews: row.totalReviews,
                businessSummary: row.businessSummary || "",
                category: [catObj._id],
                subCategory: subCatObj ? [subCatObj._id] : [],
                verified: false,
                claimed: false,
                isBlocked: false,
                profileCompletionScore: 70,
                needsGeocoding: row.needsGeocoding,
              },
            },
          });
          bulkOpTypes.push("insert");
          bulkOpCountries.push(row.address.country);
          if (row.needsGeocoding) geocodingCandidates.push(businessId);
        }
      } catch (err) {
        skipped++;
        errors.push(`Error processing row "${row.businessName}": ${err.message}`);
      }
    }

    if (bulkOps.length > 0) {
      const plannedInserts = bulkOpTypes.filter((type) => type === "insert").length;
      const plannedUpdates = bulkOpTypes.length - plannedInserts;
      let insertedCount = 0;
      let matchedCount = 0;
      let modifiedCount = 0;
      let successfulOperationIndexes = [];

      const readResultCount = (result, key, legacyKey) => Number(
        result?.[key] ??
        result?.result?.[key] ??
        result?.result?.result?.[legacyKey] ??
        0
      );

      try {
        const bulkResult = await Business.bulkWrite(bulkOps, { ordered: false });
        insertedCount = readResultCount(bulkResult, "insertedCount", "nInserted");
        matchedCount = readResultCount(bulkResult, "matchedCount", "nMatched");
        modifiedCount = readResultCount(bulkResult, "modifiedCount", "nModified");
        successfulOperationIndexes = bulkOps.map((_, index) => index);
      } catch (err) {
        errors.push(`Bulk write error: ${err.message}`);
        const partialResult = err.result || err;
        insertedCount = readResultCount(partialResult, "insertedCount", "nInserted");
        matchedCount = readResultCount(partialResult, "matchedCount", "nMatched");
        modifiedCount = readResultCount(partialResult, "modifiedCount", "nModified");

        const writeErrors = err.writeErrors || [];
        const failedOperationIndexes = new Set(writeErrors.map((writeError) => writeError.index));
        if (writeErrors.length > 0) {
          successfulOperationIndexes = bulkOps
            .map((_, index) => index)
            .filter((index) => !failedOperationIndexes.has(index));
        }
        writeErrors.slice(0, 10).forEach((writeError) => {
          const index = writeError.index;
          const name = bulkOps[index]?.insertOne?.document?.businessName || `operation ${index + 1}`;
          errors.push(`Failed to import ${name}: ${writeError.errmsg || writeError.message || "database error"}`);
        });
      }

      created += insertedCount;
      updated += modifiedCount;
      unchanged += Math.max(0, matchedCount - modifiedCount);
      skipped += Math.max(0, plannedInserts - insertedCount);
      skipped += Math.max(0, plannedUpdates - matchedCount);
      successfulOperationIndexes.forEach((index) => {
        const affectedCountry = bulkOpCountries[index];
        if (affectedCountry) affectedCountries.add(normalizeCountry(affectedCountry));
      });

      if (geocodingCandidates.length > 0) {
        try {
          const businessesToGeocode = await Business.find({
            _id: { $in: geocodingCandidates },
            needsGeocoding: true,
          }).select("_id");
          const queueResults = await Promise.allSettled(
            businessesToGeocode.map((business) => addJob("geocoding-batch", { businessId: business._id }))
          );
          const queueFailures = queueResults.filter((result) => result.status === "rejected").length;
          if (queueFailures > 0) warnings.push(`Imported successfully, but ${queueFailures} geocoding jobs could not be queued.`);
        } catch (err) {
          warnings.push(`Imported successfully, but geocoding could not be queued: ${err.message}`);
        }
      }
    }
  };

  const sendResponse = () => {
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {}
    console.log(`[BulkImport] Done — created:${created} updated:${updated} unchanged:${unchanged} skipped:${skipped} errors:${errors.length}`);
    if (errors.length > 0) console.warn(`[BulkImport] First errors:`, errors.slice(0, 5));
    if (!res.headersSent) {
      res.json({
        message: "Import completed",
        created,
        updated,
        unchanged,
        skipped,
        affectedCountries: Array.from(affectedCountries).sort(),
        errors: errors.length > 20 ? errors.slice(0, 20).concat([`... and ${errors.length - 20} more`]) : errors,
        warnings: warnings.length > 20 ? warnings.slice(0, 20).concat([`... and ${warnings.length - 20} more`]) : warnings,
      });
    }
  };

  // ── CSV path ──────────────────────────────────────────────────────────────
  if (fileExt === ".csv") {
    let currentChunk = [];

    const streamWorker = {
      queue: [],
      processing: false,
      finished: false,
      push(chunk) { this.queue.push(chunk); this.process(); },
      async process() {
        if (this.processing || this.queue.length === 0) return;
        this.processing = true;
        const chunk = this.queue.shift();
        try {
          await processChunk(chunk);
        } catch (err) {
          console.error("Chunk processing error:", err);
          errors.push(`Chunk error: ${err.message}`);
        } finally {
          this.processing = false;
          this.process();
          this.checkFinish();
        }
      },
      finish() { this.finished = true; this.checkFinish(); },
      checkFinish() {
        if (this.finished && !this.processing && this.queue.length === 0) {
          sendResponse();
        }
      },
    };

    fs.createReadStream(filePath)
      .pipe(csv({
        mapHeaders: ({ header }) => String(header || "").replace(/^\uFEFF/, "").trim(),
      }))
      .on("data", (data) => {
        currentChunk.push(data);
        if (currentChunk.length >= CHUNK_SIZE) {
          const chunkToProcess = [...currentChunk];
          currentChunk = [];
          streamWorker.push(chunkToProcess);
        }
      })
      .on("end", () => {
        if (currentChunk.length > 0) streamWorker.push(currentChunk);
        streamWorker.finish();
      })
      .on("error", (err) => {
        console.error("CSV stream error:", err);
        errors.push(`CSV parse error: ${err.message}`);
        sendResponse();
      });

  // ── Excel path ─────────────────────────────────────────────────────────────
  } else {
    try {
      let rows = [];

      try {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(filePath);

        const worksheet = workbook.worksheets[0];
        if (!worksheet) throw new Error("Workbook does not contain a worksheet.");

        // Build header map from first row
        const headers = [];
        worksheet.getRow(1).eachCell({ includeEmpty: true }, (cell, colNumber) => {
          headers[colNumber] = String(cell.value || "").replace(/^\uFEFF/, "").trim();
        });

        // Convert each data row into a plain object keyed by header
        worksheet.eachRow((row, rowNumber) => {
          if (rowNumber === 1) return; // skip header row
          const obj = {};
          row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
            const header = headers[colNumber];
            if (header) {
              const value = cell.value;
              obj[header] = value === null || value === undefined
                ? ""
                : typeof value === "object" && value.text
                  ? value.text
                  : String(value);
            }
          });
          if (Object.values(obj).some((value) => String(value).trim())) rows.push(obj);
        });
      } catch (excelJsError) {
        // ExcelJS crashes on some valid workbooks that use prefixed XML
        // namespaces. SheetJS provides a more tolerant compatibility path.
        console.warn(`[BulkImport] ExcelJS parser failed; using XLSX fallback: ${excelJsError.message}`);
        const workbook = XLSX.readFile(filePath, { cellDates: false });
        const firstSheetName = workbook.SheetNames?.[0];
        const worksheet = firstSheetName ? workbook.Sheets[firstSheetName] : null;
        if (!worksheet) throw new Error("Workbook does not contain a readable worksheet.");
        rows = XLSX.utils.sheet_to_json(worksheet, {
          defval: "",
          raw: false,
          blankrows: false,
        });
      }

      if (rows.length === 0) throw new Error("The first worksheet does not contain any business rows.");

      // Process in chunks
      for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
        await processChunk(rows.slice(i, i + CHUNK_SIZE));
      }

      sendResponse();
    } catch (err) {
      console.error("Excel parse error:", err);
      try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {}
      if (!res.headersSent) {
        res.status(400).json({
          message: "The Excel file could not be read. Please verify that it is a valid .xlsx workbook.",
          created,
          updated,
          unchanged,
          skipped,
          errors: [`Excel parse error: ${err.message}`],
          warnings,
        });
      }
    }
  }
};


exports.downloadSampleCSV = async (req, res) => {
  try {
    const csvContent = [
      "Business Name,Phone,Email,Address,Website,Rating,Reviews,Latitude,Longitude,Category,Subcategory,Country",
      'DigitalMitro,9876543210,info@digitalmitro.com,"123 Tech St; Salt Lake; Kolkata; West Bengal; 700091; India",https://digitalmitro.com,4.5,120,22.5726,88.3639,Marketing Agency,Digital Marketing,India',
      'Urban Citations,+442071234567,contact@urbancitations.com,"45 High St; Central; London; Greater London; WC1 1AA; United Kingdom",https://urbancitations.com,4.2,80,51.5074,-0.1278,Business Service,Local Listing,United Kingdom',
      'Example Business,12125550199,hello@example.com,"789 Broadway; Manhattan; New York; NY; 10003; United States",https://example.com,3.8,45,40.7282,-73.9942,Retail,Clothing,United States'
    ].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=sample_business_import.csv");
    res.status(200).send(csvContent);
  } catch (error) {
    console.error("Error generating sample CSV:", error);
    res.status(500).json({ message: "Failed to generate sample CSV" });
  }
};

exports.downloadSampleExcel = async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Urban Citations Admin";
    workbook.created = new Date();

    const worksheet = workbook.addWorksheet("Businesses", {
      views: [{ state: "frozen", ySplit: 1 }],
    });

    // Define columns
    const columns = [
      { header: "Business Name", key: "Business Name", width: 30 },
      { header: "Phone", key: "Phone", width: 18 },
      { header: "Email", key: "Email", width: 30 },
      { header: "Address", key: "Address", width: 60 },
      { header: "Website", key: "Website", width: 35 },
      { header: "Rating", key: "Rating", width: 10 },
      { header: "Reviews", key: "Reviews", width: 10 },
      { header: "Latitude", key: "Latitude", width: 14 },
      { header: "Longitude", key: "Longitude", width: 14 },
      { header: "Category", key: "Category", width: 25 },
      { header: "Subcategory", key: "Subcategory", width: 25 },
      { header: "Country", key: "Country", width: 20 },
    ];
    worksheet.columns = columns;

    // Style header row
    const headerRow = worksheet.getRow(1);
    headerRow.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1976D2" } };
      cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      cell.border = { bottom: { style: "thin" } };
    });
    headerRow.height = 24;

    // Example data rows
    const examples = [
      {
        "Business Name": "DigitalMitro",
        Phone: "9876543210",
        Email: "info@digitalmitro.com",
        Address: "123 Tech St; Salt Lake; Kolkata; West Bengal; 700091; India",
        Website: "https://digitalmitro.com",
        Rating: 4.5,
        Reviews: 120,
        Latitude: 22.5726,
        Longitude: 88.3639,
        Category: "Marketing Agency",
        Subcategory: "Digital Marketing",
        Country: "India",
      },
      {
        "Business Name": "Urban Citations",
        Phone: "+442071234567",
        Email: "contact@urbancitations.com",
        Address: "45 High St; Central; London; Greater London; WC1 1AA; United Kingdom",
        Website: "https://urbancitations.com",
        Rating: 4.2,
        Reviews: 80,
        Latitude: 51.5074,
        Longitude: -0.1278,
        Category: "Business Service",
        Subcategory: "Local Listing",
        Country: "United Kingdom",
      },
      {
        "Business Name": "Example Business",
        Phone: "12125550199",
        Email: "hello@example.com",
        Address: "789 Broadway; Manhattan; New York; NY; 10003; United States",
        Website: "https://example.com",
        Rating: 3.8,
        Reviews: 45,
        Latitude: 40.7282,
        Longitude: -73.9942,
        Category: "Retail",
        Subcategory: "Clothing",
        Country: "United States",
      },
    ];

    examples.forEach((ex) => {
      const row = worksheet.addRow(ex);
      row.eachCell((cell) => {
        cell.alignment = { vertical: "middle", wrapText: true };
      });
    });

    // Alternate row shading for data rows
    for (let i = 2; i <= worksheet.rowCount; i++) {
      if (i % 2 === 0) {
        worksheet.getRow(i).eachCell((cell) => {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF0F7FF" } };
        });
      }
    }

    const instructions = workbook.addWorksheet("Instructions");
    instructions.columns = [
      { header: "Field", key: "field", width: 24 },
      { header: "Guidance", key: "guidance", width: 80 },
    ];
    instructions.addRows([
      { field: "Business Name", guidance: "Required." },
      { field: "Phone", guidance: "Required. Use 7 to 15 digits; spaces, +, hyphens, and parentheses are accepted." },
      { field: "Email", guidance: "Required. Must be a valid email address." },
      { field: "Address", guidance: "Optional. Structured format supported: Street; Area; City; State; Pincode; Country." },
      { field: "Website", guidance: "Optional. If present, it must be a valid web address." },
      { field: "Rating", guidance: "Optional. Number from 0 to 5." },
      { field: "Reviews", guidance: "Optional. Whole number 0 or greater." },
      { field: "Latitude / Longitude", guidance: "Optional. If one is supplied, both must be supplied and within valid coordinate ranges." },
      { field: "Category / Subcategory", guidance: "Optional. Values are mapped to category records when supplied." },
      { field: "Country", guidance: "Optional. Common abbreviations such as US, USA, UK, and UAE are accepted." },
    ]);
    instructions.getRow(1).eachCell((cell) => {
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1976D2" } };
    });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=sample_business_import.xlsx");
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error("Error generating sample Excel:", error);
    res.status(500).json({ message: "Failed to generate sample Excel" });
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

    // Removed console.log from hot path

    // Fetch businesses
    const businesses = await Business.find(query)
      .select(
        "businessName address contact businessTiming verified trust claimed isBlocked subscriptionActive _id rating totalReviews businessLogo photos"
      )
      .sort({ updatedAt: -1, _id: -1 })
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
    // Final calculation - do NOT write back to DB on every GET request
    const profileCompletionScore = Math.round(
      (completedWeight / totalWeight) * 100
    );

    // Provide the expected shape to the frontend without the DB write storm
    const businessDataForClient = {
      ...business.toObject({ flattenMaps: true }),
      profileCompletionScore,
      enquiryCount,
      offerCount: offersWithService.length,
    };

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
        ...businessDataForClient,
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
          isPremium: {
            $cond: {
              if: { $eq: ["$subscription.status", "active"] },
              then: 1,
              else: 0,
            },
          },
        },
      },
      {
        $sort: {
          isPremium: -1,
          createdAt: -1,
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
    
    // 1. Find the business to see if it exists and get its owner
    const business = await Business.findById(businessId);
    if (!business) {
      return res.status(404).json({ message: "Business not found" });
    }

    const ownerId = business.userId;

    // 2. Delete the business
    await Business.findByIdAndDelete(businessId);

    // 3. Remove this business from ALL users' businesses array (just in case of duplicates)
    await User.updateMany(
      { businesses: businessId },
      { $pull: { businesses: businessId } }
    );

    // 4. Update isSeller status for the specific owner (if any)
    if (ownerId) {
      const owner = await User.findById(ownerId);
      if (owner && owner.businesses.length === 0) {
        owner.isSeller = false;
        await owner.save();
      }
    }

    res.status(200).json({ message: "Business successfully deleted and user records updated" });
  } catch (error) {
    console.error("Error deleting business:", error);
    res.status(500).json({ message: "Internal server error", error: error.message });
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
      "category", // Added to allow category updates
      "subCategory", // Added to allow subcategory updates
    ];

    const updates = {};
    for (const field of allowedFields) {
      if (parsedData.hasOwnProperty(field)) {
        let value = parsedData[field];
        if (field === "address" && value?.country) {
          value.country = normalizeCountry(value.country);
        }
        updates[field] = value;
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

    // Capture the business before update to check ownership
    const businessBefore = await Business.findById(id);
    if (!businessBefore) {
      return res.status(404).json({ message: "Business not found" });
    }

    // If unclaiming, clear userId
    if (claimed === false) {
      updateData.userId = null;
      
      // Remove from previous owner's list
      if (businessBefore.userId) {
        await User.findByIdAndUpdate(businessBefore.userId, {
          $pull: { businesses: id }
        });
        
        // Update isSeller if needed
        const prevUser = await User.findById(businessBefore.userId);
        if (prevUser && prevUser.businesses.length === 0) {
          prevUser.isSeller = false;
          await prevUser.save();
        }
      }
    }

    const business = await Business.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true }
    );

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

    // Notify Admins about KYC submission
    await notifyAdmins({
      title: "KYC Submitted",
      description: `New KYC documents submitted for ${updatedBusiness.businessName}.`,
      link: `/view-business/${updatedBusiness._id}`,
      category: "kyc",
    });

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
    
    // Fetch businesses where this user is the owner
    const businesses = await Business.find({ userId: userId }).lean();
    
    // Also get basic user info
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.status(200).json({
      full_name: user.full_name,
      email: user.email,
      userImage: user.userImage,
      isSeller: user.isSeller,
      businesses: businesses,
    });
  } catch (error) {
    console.error("Error in getuserBusiness:", error);
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
      search,
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
      ...(search && { businessName: { $regex: search, $options: "i" } }),
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

      // Add isPremium field based on active subscription
      {
        $addFields: {
          isPremium: {
            $cond: {
              if: { $eq: ["$subscription.status", "active"] },
              then: 1,
              else: 0,
            },
          },
        },
      },

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

      // Final Sort: Premium first, then Distance, then user choice
      {
        $sort: {
          isPremium: -1,
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

    // Total Count Pipeline combined with results using $facet for better performance
    const facetPipeline = pipeline.filter(
      (stage) => !["$skip", "$limit"].includes(Object.keys(stage)[0])
    );

    facetPipeline.push({
      $facet: {
        data: [{ $skip: skip }, { $limit: Number(limit) }],
        totalCount: [{ $count: "total" }],
      },
    });

    const [facetResult] = await Business.aggregate(facetPipeline);
    const businesses = facetResult?.data || [];
    const total = facetResult?.totalCount?.[0]?.total || 0;

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

// VALID_COUNTRIES moved to top for optimization

exports.getDistinctCountries = async (req, res) => {
  try {
    const rawCountries = await Business.distinct("address.country");
    
    const filteredCountries = rawCountries
      .filter(Boolean)
      .map(c => normalizeCountry(c))
      .map(c => {
        // Find in VALID_COUNTRIES to get standard casing
        const standardName = VALID_COUNTRIES.find(v => v.toLowerCase() === c.toLowerCase());
        return standardName || c;
      })
      .filter(c => VALID_COUNTRIES.includes(c))
      .filter((v, i, a) => a.indexOf(v) === i)
      .sort();
    
    res.status(200).json(filteredCountries);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch countries", error: error.message });
  }
};

exports.searchBusinesses = async (req, res) => {
  try {
    const { query, location } = req.query;
    if (!query) {
      return res.status(200).json([]);
    }

    // Search by name globally first (matching names should ALWAYS come)
    const nameFilter = {
      businessName: { $regex: query, $options: "i" },
      isBlocked: false,
    };

    const businesses = await Business.find(nameFilter)
      .select("businessName _id category address addressString kyc businessLogo")
      .limit(20);

    let formattedBusinesses = businesses.map((biz) => {
      const addr = biz.address || {};
      const displayAddress = [addr.area, addr.city, addr.state]
        .filter(Boolean)
        .join(", ");

      return {
        _id: biz._id,
        name: biz.businessName,
        type: "business",
        addressLabel: displayAddress || biz.addressString || "Address N/A",
        verified: biz.kyc?.status === "verified",
        iconUrl: biz.businessLogo,
      };
    });

    // If location is provided, sort local matches to the top
    if (location) {
      const locLower = location.toLowerCase();
      formattedBusinesses.sort((a, b) => {
        const aMatches = a.addressLabel?.toLowerCase().includes(locLower);
        const bMatches = b.addressLabel?.toLowerCase().includes(locLower);
        if (aMatches && !bMatches) return -1;
        if (!aMatches && bMatches) return 1;
        return 0;
      });
    }

    res.status(200).json(formattedBusinesses.slice(0, 10));
  } catch (error) {
    res.status(500).json({ message: "Search failed", error: error.message });
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
