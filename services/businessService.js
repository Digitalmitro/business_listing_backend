// backend/services/businessService.js
"use strict";

const mongoose = require("mongoose");
const Business = require("../models/Business");
const User = require("../models/User");
const Category = require("../models/Category");
const SubCategory = require("../models/SubCategory");
const queue = require("../utils/queue");
const notificationHelper = require("../helpers/notificationHelper");
const { normalizeCountry } = require("../helpers/country");
const logger = require("../utils/logger");

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
    this.status = 400;
  }
}

function toObjectIdArray(items) {
  if (!Array.isArray(items)) items = items ? [items] : [];
  return items
    .map((item) => (typeof item === "object" && item?._id ? item._id : item))
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));
}

/**
 * Creates a Business document from normalized `businessData`, shared by the
 * manual business-creation controller and the Google Business Profile import
 * service. Both callers build/validate `businessData` first (manual: from the
 * multipart form; Google import: mapped from a fetched Location) and pass it
 * here so there is exactly one place that constructs and saves a Business.
 *
 * @param {Object} params
 * @param {string|null} params.ownerId - User._id owning the business, or null for admin-created listings.
 * @param {boolean} params.isAdmin - Whether the caller is an admin (skips the ownerId requirement and marks claimed=false).
 * @param {Object} params.businessData - Normalized business fields (see below).
 * @param {Object} [params.files] - `{ businessLogo: [file], photos: [file, ...] }` from multer, filenames only.
 * @param {Object} [params.extra] - Additional fields not present in the manual form (Google import path):
 *   googleLocationId, creationSource, googleAccountName, googleLastSyncedAt,
 *   description, website, importedCategory, servicesTypes, socialLinks, needsGeocoding,
 *   businessLogo (absolute URL string), photos (array of absolute URL strings).
 */
async function createBusiness({ ownerId, isAdmin = false, businessData, files = {}, extra = {} }) {
  if (!businessData) {
    throw new ValidationError("Add all mandatory fields.");
  }

  const coords = businessData.address?.coordinates;
  const hasLatitudeValue = coords?.latitude !== undefined && coords?.latitude !== null && coords?.latitude !== "";
  const hasLongitudeValue = coords?.longitude !== undefined && coords?.longitude !== null && coords?.longitude !== "";
  const latitude = Number(coords?.latitude);
  const longitude = Number(coords?.longitude);
  const hasCoords = hasLatitudeValue && hasLongitudeValue && Number.isFinite(latitude) && Number.isFinite(longitude);
  if (!hasCoords && !extra.needsGeocoding) {
    throw new ValidationError("Latitude and longitude are required.");
  }

  // Normalize categories (handle 'categories' vs 'category' and object vs ID string)
  const validCategories = toObjectIdArray(businessData.categories || businessData.category || []);
  const validSubCategories = toObjectIdArray(businessData.subCategories || businessData.subCategory || []);

  if (validCategories.length === 0) {
    throw new ValidationError("At least one category is required.");
  }
  const existingCategories = await Category.find({ _id: { $in: validCategories } });
  if (existingCategories.length !== validCategories.length) {
    throw new ValidationError("One or more categories are invalid.");
  }

  if (validSubCategories.length > 0) {
    const existingSubCategories = await SubCategory.find({ _id: { $in: validSubCategories } });
    if (existingSubCategories.length !== validSubCategories.length) {
      throw new ValidationError("One or more subcategories are invalid.");
    }
  }

  // Attach uploaded file names
  const businessLogoFile = files?.businessLogo?.[0];
  const photoFiles = Array.isArray(files?.photos) ? files.photos : files?.photos ? [files.photos] : [];

  // Initialize and validate contact object
  const contact = businessData.contact || {};
  const { mobile, whatsapp, email, contactDetails } = contact;

  const filtered = (values) => (Array.isArray(values) ? values.filter((value) => String(value || "").trim()) : []);
  const validatedContactDetails =
    Array.isArray(contactDetails) && contactDetails.length > 0
      ? contactDetails.map((cd) => ({
          title: cd.title || "Mr",
          name: cd.name || "Default Name",
          designation: cd.designation || "",
          mobileNumbers: filtered(cd.mobileNumbers).length ? filtered(cd.mobileNumbers) : filtered(mobile),
          whatsappNumbers: filtered(cd.whatsappNumbers).length ? filtered(cd.whatsappNumbers) : filtered(whatsapp),
          emails: filtered(cd.emails).length ? filtered(cd.emails) : filtered(email),
        }))
      : [
          {
            title: "Mr",
            name: contactDetails?.[0]?.name || "Default Name",
            designation: contactDetails?.[0]?.designation || "",
            mobileNumbers: filtered(mobile),
            whatsappNumbers: filtered(whatsapp),
            emails: filtered(email),
          },
        ];

  const needsGeocoding = Boolean(extra.needsGeocoding) && !hasCoords;

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
    },
    location: {
      type: "Point",
      coordinates: hasCoords ? [longitude, latitude] : [0, 0],
    },
    contact: {
      contactDetails: validatedContactDetails,
      mobile: filtered(mobile),
      whatsapp: filtered(whatsapp),
      email: filtered(email),
    },
    businessTiming: {
      isOpen24Hours: businessData.businessTiming?.isOpen24Hours ?? false,
      daysOfWeek: businessData.businessTiming?.daysOfWeek || [],
      schedule: businessData.businessTiming?.schedule || {},
    },
    category: validCategories,
    subCategory: validSubCategories,
    businessLogo: businessLogoFile ? businessLogoFile.filename : extra.businessLogo || undefined,
    photos: photoFiles.length > 0 ? photoFiles.map((p) => p.filename) : extra.photos || undefined,
    userId: isAdmin ? null : ownerId,
    claimed: !isAdmin,
    isAdmin,
    needsGeocoding,
  };

  if (extra.googleLocationId) newBusinessData.googleLocationId = extra.googleLocationId;
  if (extra.creationSource) newBusinessData.creationSource = extra.creationSource;
  if (extra.googleAccountName) newBusinessData.googleAccountName = extra.googleAccountName;
  if (extra.googleLastSyncedAt) newBusinessData.googleLastSyncedAt = extra.googleLastSyncedAt;
  if (extra.description || businessData.description) newBusinessData.description = extra.description || businessData.description;
  if (extra.website || businessData.website) newBusinessData.website = extra.website || businessData.website;
  if (businessData.businessSummary) newBusinessData.businessSummary = businessData.businessSummary;
  if (extra.importedCategory) newBusinessData.importedCategory = extra.importedCategory;
  const servicesTypes = extra.servicesTypes || businessData.servicesTypes;
  if (servicesTypes?.length) newBusinessData.servicesTypes = servicesTypes;
  const socialLinks = extra.socialLinks || businessData.socialLinks;
  if (socialLinks && Object.keys(socialLinks).length) newBusinessData.socialLinks = socialLinks;

  const newBusiness = new Business(newBusinessData);
  const savedBusiness = await newBusiness.save();

  if (!isAdmin && ownerId) {
    const user = await User.findById(ownerId);
    if (!user) {
      throw new ValidationError("User not found.");
    }
    user.businesses.push(savedBusiness._id);
    user.isSeller = true;
    await user.save();
  }

  if (needsGeocoding) {
    try {
      await queue.addJob("geocoding-batch", { businessId: savedBusiness._id });
    } catch (err) {
      logger.warn("business.geocoding_queue.failed", { businessId: savedBusiness._id, error: err.message });
    }
  }

  try {
    await notificationHelper.notifyAdmins({
      title: "New Business Listed",
      description: `${savedBusiness.businessName} has been listed on the platform.`,
      link: `/view-business/${savedBusiness._id}`,
      category: "business",
    });
  } catch (err) {
    logger.warn("business.notify_admins.failed", { businessId: savedBusiness._id, error: err.message });
  }

  return savedBusiness;
}

module.exports = {
  ValidationError,
  createBusiness,
};
