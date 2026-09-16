// backend/services/googleBusinessImportService.js
"use strict";

const mongoose = require("mongoose");
const Business = require("../models/Business");
const Category = require("../models/Category");
const SubCategory = require("../models/SubCategory");
const logger = require("../utils/logger");
const { normalizeCountry, countryNameFromRegionCode } = require("../helpers/country");
const { escapeRegex } = require("./businessImportService");
const businessService = require("./businessService");
const googleBusinessService = require("./googleBusinessService");

class ValidationError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = "ValidationError";
    this.status = 400;
    Object.assign(this, extra);
  }
}

class NotAuthorizedError extends Error {
  constructor(message = "You are not authorized to access this Google Business Profile location") {
    super(message);
    this.name = "NotAuthorizedError";
    this.status = 403;
  }
}

/** Thrown when the Google location is already linked to a Business owned by a different UC account. */
class LinkedToOtherAccountError extends Error {
  constructor(existingBusinessId) {
    super("This Google Business Profile is already linked to another Urban Citation business");
    this.name = "LinkedToOtherAccountError";
    this.status = 409;
    this.existingBusinessId = existingBusinessId;
    this.claimable = true;
  }
}

// Sentinel "unknown" values already used by the existing CSV/XLSX import (services/businessImportService.js
// parseAddress) and by the pre-existing Google auto-import for required-but-missing address fields. Reused
// here instead of inventing a new placeholder scheme, and treated as "still unset" by the sync logic below.
const DEFAULT_CITY = "Unknown City";
const DEFAULT_STATE = "Unknown State";
const DEFAULT_PINCODE = "000000";
const DEFAULT_COUNTRY = "Unknown Country";
const DEFAULT_LOGO = "https://img.icons8.com/fluency/100/000000/organization.png";
const DEFAULT_PHOTO = "https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?q=80&w=1000&auto=format&fit=crop";

const DAY_MAP = {
  MONDAY: "Mon",
  TUESDAY: "Tue",
  WEDNESDAY: "Wed",
  THURSDAY: "Thu",
  FRIDAY: "Fri",
  SATURDAY: "Sat",
  SUNDAY: "Sun",
};
const DAY_ORDER = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];

function nextGoogleDay(day) {
  const idx = DAY_ORDER.indexOf(day);
  return idx === -1 ? null : DAY_ORDER[(idx + 1) % 7];
}

function formatTimeOfDay(t) {
  if (!t) return null;
  const h = Number(t.hours || 0);
  const m = Number(t.minutes || 0);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Maps Google's regularHours.periods (Business Information API v1 TimePeriod[]) to the
 * UC businessTiming shape ({ isOpen24Hours, daysOfWeek, schedule }). Google represents a
 * 24-hour day as openTime 00:00 rolling to closeDay = next day at 00:00; UC represents the
 * same day as a single { openAt: "00:00", closeAt: "23:59" } slot (matching how the manual
 * form's 24-hour toggle already encodes a day, see BusinesForm.jsx).
 * A period that crosses midnight without being a full 24h day keeps closeAt as Google gave
 * it (UC's per-day schedule has no way to represent a close time "the next day").
 */
function mapGoogleHoursToBusinessTiming(periods = []) {
  const schedule = {};
  const daysWithHours = new Set();
  const full24Days = new Set();

  for (const period of Array.isArray(periods) ? periods : []) {
    const openDay = period?.openDay;
    if (!openDay || !DAY_MAP[openDay]) continue;

    const openTime = formatTimeOfDay(period.openTime) || "00:00";
    const closeDay = period.closeDay || openDay;
    let closeTime = formatTimeOfDay(period.closeTime) || "00:00";

    const isFull24h = openTime === "00:00" && closeTime === "00:00" && closeDay === nextGoogleDay(openDay);
    if (isFull24h) {
      full24Days.add(openDay);
      closeTime = "23:59";
    }

    const dayKey = DAY_MAP[openDay];
    schedule[dayKey] = schedule[dayKey] || [];
    schedule[dayKey].push({ openAt: openTime, closeAt: closeTime });
    daysWithHours.add(openDay);
  }

  const daysOfWeek = DAY_ORDER.filter((d) => daysWithHours.has(d)).map((d) => DAY_MAP[d]);
  const isOpen24Hours = daysWithHours.size === 7 && full24Days.size === 7;

  return { isOpen24Hours, daysOfWeek, schedule };
}

/** True when a stored value is empty or one of the "unknown" import sentinels — i.e. safe to overwrite during sync. */
function isUnset(value) {
  if (value === undefined || value === null) return true;
  const v = String(value).trim().toLowerCase();
  return v === "" || v === "unknown" || v === DEFAULT_CITY.toLowerCase() || v === DEFAULT_STATE.toLowerCase() || v === DEFAULT_COUNTRY.toLowerCase() || v === DEFAULT_PINCODE;
}

/**
 * Builds the { businessData, extra } pair consumed by businessService.createBusiness()
 * from a normalized Google profile (googleBusinessService.normalizeLocation output).
 * Pure and unit-testable: no I/O.
 */
function hasUsableCoordinates(profile) {
  const latitude = Number(profile.locationDetails?.latitude);
  const longitude = Number(profile.locationDetails?.longitude);
  return Number.isFinite(latitude) && Number.isFinite(longitude) && !(latitude === 0 && longitude === 0);
}

function mapProfileToBusinessPayload(profile, user, { categoryId, subCategoryIds = [], media = {}, accountName } = {}) {
  const hasCoords = hasUsableCoordinates(profile);
  const regionName = countryNameFromRegionCode(profile.address?.country);
  const country = normalizeCountry(regionName || profile.address?.country || DEFAULT_COUNTRY);
  const timing = mapGoogleHoursToBusinessTiming(profile.businessHours?.periods);
  const phones = [profile.phoneNumber, ...(profile.additionalPhones || [])].filter(Boolean);

  const businessData = {
    businessName: profile.businessName || "",
    address: {
      blockName: "",
      streetName: profile.address?.streetName || "",
      area: "",
      landmark: "",
      city: profile.address?.city || DEFAULT_CITY,
      state: profile.address?.state || DEFAULT_STATE,
      pincode: profile.address?.pincode || DEFAULT_PINCODE,
      country,
      coordinates: hasCoords
        ? { latitude: profile.locationDetails.latitude, longitude: profile.locationDetails.longitude }
        : { latitude: 0, longitude: 0 },
    },
    contact: {
      mobile: phones,
      whatsapp: [],
      email: [],
      contactDetails: [
        {
          title: "Mr",
          name: user.full_name || "Owner",
          designation: "",
          mobileNumbers: phones,
          whatsappNumbers: [],
          emails: [],
        },
      ],
    },
    businessTiming: timing,
    category: categoryId ? [categoryId] : [],
    subCategory: subCategoryIds,
  };

  const extra = {
    googleLocationId: profile.businessId || undefined,
    creationSource: "google_business",
    googleAccountName: accountName || profile.accountName || undefined,
    googleLastSyncedAt: new Date(),
    description: profile.description || undefined,
    website: profile.website || undefined,
    importedCategory: profile.category || undefined,
    servicesTypes: profile.additionalCategories?.length ? profile.additionalCategories : undefined,
    socialLinks: profile.mapsUri ? { googleMaps: profile.mapsUri } : undefined,
    needsGeocoding: !hasCoords,
    businessLogo: media.logoUrl || undefined,
    photos: media.photoUrls?.length ? media.photoUrls : undefined,
  };

  return { businessData, extra };
}

/**
 * Finds a Business already linked to this Google location, preferring the durable
 * googleLocationId identifier over the business name (Google's own unique id, per
 * the task's duplicate-prevention requirement). Falls back to an escaped, exact,
 * case-insensitive name match against the current user's own businesses only —
 * never against another user's businesses by name alone, to avoid accidental
 * cross-account matches on a common business name.
 */
function normalizeMatchText(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function businessPhones(business) {
  const contacts = business.contact?.contactDetails || [];
  return [
    ...(business.contact?.mobile || []),
    ...contacts.flatMap((contact) => contact.mobileNumbers || []),
  ].map(normalizePhone).filter(Boolean);
}

function isStrongManualMatch(business, profile) {
  const googlePhones = [profile.phoneNumber, ...(profile.additionalPhones || [])].map(normalizePhone).filter(Boolean);
  if (googlePhones.some((phone) => businessPhones(business).includes(phone))) return true;

  const businessCity = normalizeMatchText(business.address?.city);
  const googleCity = normalizeMatchText(profile.address?.city);
  const businessPincode = normalizeMatchText(business.address?.pincode);
  const googlePincode = normalizeMatchText(profile.address?.pincode);
  if (businessCity && googleCity && businessPincode && googlePincode) {
    return businessCity === googleCity && businessPincode === googlePincode;
  }

  const [longitude, latitude] = business.location?.coordinates || [];
  if (hasUsableCoordinates(profile) && Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude))) {
    return Math.abs(Number(latitude) - Number(profile.locationDetails.latitude)) <= 0.001
      && Math.abs(Number(longitude) - Number(profile.locationDetails.longitude)) <= 0.001;
  }
  return false;
}

async function findLinkedBusiness(userId, profile) {
  if (profile.businessId) {
    const byGoogleId = await Business.findOne({ googleLocationId: profile.businessId });
    if (byGoogleId) return byGoogleId;
  }
  if (profile.businessName) {
    const sameName = await Business.find({
      userId,
      businessName: { $regex: new RegExp(`^${escapeRegex(profile.businessName.trim())}$`, "i") },
    });
    const strongMatches = sameName.filter((business) => isStrongManualMatch(business, profile));
    if (strongMatches.length === 1) return strongMatches[0];
  }
  return null;
}

/** Refreshes provider-owned fields on Google imports; manual links are fill-only. */
async function syncLinkedBusiness(business, profile, media = {}, { accountName } = {}) {
  let dirty = false;
  const replaceGoogleFields = business.creationSource === "google_business";

  const assign = (target, key, value, { canClear = false } = {}) => {
    if ((!canClear && isUnset(value)) || target[key] === value) return;
    target[key] = value;
    dirty = true;
  };

  if (!business.googleLocationId && profile.businessId) {
    business.googleLocationId = profile.businessId;
    dirty = true;
  }
  if (accountName && business.googleAccountName !== accountName) {
    business.googleAccountName = accountName;
    dirty = true;
  }
  if (replaceGoogleFields && profile.businessName) assign(business, "businessName", profile.businessName);
  if (isUnset(business.description) && profile.description) {
    business.description = profile.description;
    dirty = true;
  }
  if (replaceGoogleFields) {
    assign(business, "description", profile.description || "", { canClear: true });
    assign(business, "website", profile.website || "", { canClear: true });
    assign(business, "importedCategory", profile.category || "", { canClear: true });
    business.servicesTypes = profile.additionalCategories || [];
    dirty = true;
  }
  if (isUnset(business.website) && profile.website) {
    business.website = profile.website;
    dirty = true;
  }
  if (isUnset(business.importedCategory) && profile.category) {
    business.importedCategory = profile.category;
    dirty = true;
  }
  if (!replaceGoogleFields && (!business.servicesTypes || business.servicesTypes.length === 0) && profile.additionalCategories?.length) {
    business.servicesTypes = profile.additionalCategories;
    dirty = true;
  }
  if (profile.mapsUri) {
    const links = business.socialLinks instanceof Map ? business.socialLinks : new Map(Object.entries(business.socialLinks || {}));
    if (!links.get("googleMaps") || (replaceGoogleFields && links.get("googleMaps") !== profile.mapsUri)) {
      links.set("googleMaps", profile.mapsUri);
      business.socialLinks = links;
      dirty = true;
    }
  }

  const addr = business.address ? business.address.toObject?.() || { ...business.address } : {};
  let addrChanged = false;
  if (isUnset(addr.city) && profile.address?.city) { addr.city = profile.address.city; addrChanged = true; }
  if (isUnset(addr.state) && profile.address?.state) { addr.state = profile.address.state; addrChanged = true; }
  if (isUnset(addr.pincode) && profile.address?.pincode) { addr.pincode = profile.address.pincode; addrChanged = true; }
  if (isUnset(addr.streetName) && profile.address?.streetName) { addr.streetName = profile.address.streetName; addrChanged = true; }
  if (isUnset(addr.country) && profile.address?.country) {
    addr.country = normalizeCountry(countryNameFromRegionCode(profile.address.country) || profile.address.country);
    addrChanged = true;
  }
  if (addrChanged) {
    business.address = addr;
    dirty = true;
  }

  if (replaceGoogleFields) {
    const regionName = countryNameFromRegionCode(profile.address?.country);
    business.address = {
      ...addr,
      streetName: profile.address?.streetName || "",
      city: profile.address?.city || DEFAULT_CITY,
      state: profile.address?.state || DEFAULT_STATE,
      pincode: profile.address?.pincode || DEFAULT_PINCODE,
      country: normalizeCountry(regionName || profile.address?.country || DEFAULT_COUNTRY),
    };
    const phones = [profile.phoneNumber, ...(profile.additionalPhones || [])].filter(Boolean);
    business.contact = business.contact || {};
    business.contact.mobile = phones;
    const details = business.contact.contactDetails || [];
    if (details.length > 0) details[0].mobileNumbers = phones;
    business.businessTiming = mapGoogleHoursToBusinessTiming(profile.businessHours?.periods);
    dirty = true;
  } else {
    const phones = [profile.phoneNumber, ...(profile.additionalPhones || [])].filter(Boolean);
    business.contact = business.contact || {};
    if ((!business.contact.mobile || business.contact.mobile.length === 0) && phones.length) {
      business.contact.mobile = phones;
      const details = business.contact.contactDetails || [];
      if (details.length > 0 && (!details[0].mobileNumbers || details[0].mobileNumbers.length === 0)) {
        details[0].mobileNumbers = phones;
      }
      dirty = true;
    }
    const existingDays = business.businessTiming?.daysOfWeek || [];
    if (existingDays.length === 0 && profile.businessHours?.periods?.length) {
      business.businessTiming = mapGoogleHoursToBusinessTiming(profile.businessHours.periods);
      dirty = true;
    }
  }

  const [lng, lat] = business.location?.coordinates || [0, 0];
  if ((replaceGoogleFields || (!lng && !lat)) && hasUsableCoordinates(profile)) {
    business.location = { type: "Point", coordinates: [profile.locationDetails.longitude, profile.locationDetails.latitude] };
    business.needsGeocoding = false;
    dirty = true;
  }

  if (business.businessLogo === DEFAULT_LOGO && media.logoUrl) {
    business.businessLogo = media.logoUrl;
    dirty = true;
  }
  const hasOnlyDefaultPhoto = !business.photos || (business.photos.length === 1 && business.photos[0] === DEFAULT_PHOTO) || business.photos.length === 0;
  if (hasOnlyDefaultPhoto && media.photoUrls?.length) {
    business.photos = media.photoUrls;
    dirty = true;
  }

  if (replaceGoogleFields && media.logoUrl && business.businessLogo !== media.logoUrl) {
    business.businessLogo = media.logoUrl;
    dirty = true;
  }
  if (replaceGoogleFields && media.photoUrls?.length) {
    business.photos = media.photoUrls;
    dirty = true;
  }

  business.googleLastSyncedAt = new Date();
  dirty = true;

  if (dirty) await business.save();
  return business;
}

/**
 * Imports one Google Business Profile location, selected by the user, into UC as a
 * normal Business — creating it via the shared businessService.createBusiness() when
 * it does not already exist, or syncing an already-linked business owned by the same
 * user. Never trusts client-supplied profile data: the location is re-fetched from
 * Google with the user's own token, so Google itself is the authorization check.
 */
async function importLocation(user, { accountName, locationName, categoryId, subCategoryIds = [] } = {}) {
  if (!/^locations\/[A-Za-z0-9_-]+$/.test(locationName || "")) {
    throw new ValidationError("A valid Google location id is required.");
  }

  const connection = await googleBusinessService.connection(user);
  if (!connection) {
    throw new NotAuthorizedError("Google account is not connected; reconnect and try again.");
  }

  let profile;
  try {
    // getValidAccessToken (inside fetchProfileByLocationName) refreshes an expired token and only
    // throws when the connection is actually unusable, so the connection.status above is checked
    // only for "no row at all" — token freshness is left entirely to that existing refresh logic.
    profile = await googleBusinessService.fetchProfileByLocationName(user, locationName);
  } catch (error) {
    const httpStatus = error.response?.status;
    if (httpStatus === 403 || httpStatus === 404) {
      throw new NotAuthorizedError();
    }
    throw error;
  }

  const linked = await findLinkedBusiness(user._id, profile);
  if (linked) {
    if (String(linked.userId || "") === String(user._id)) {
      let media = {};
      if (accountName) {
        media = await googleBusinessService.fetchLocationMedia(user, accountName, locationName);
      }
      const verifiedAccountName = media.accountVerified ? accountName : undefined;
      const synced = await syncLinkedBusiness(linked, profile, media, { accountName: verifiedAccountName });
      return { business: synced, created: false };
    }
    throw new LinkedToOtherAccountError(linked._id);
  }

  let resolvedCategoryId = null;
  if (categoryId) {
    if (!mongoose.Types.ObjectId.isValid(categoryId)) {
      throw new ValidationError("Invalid category id.");
    }
    const category = await Category.findById(categoryId);
    if (!category) throw new ValidationError("Selected category does not exist.");
    resolvedCategoryId = category._id;
  } else if (profile.category) {
    const category = await Category.findOne({
      name: { $regex: new RegExp(`^${escapeRegex(profile.category.trim())}$`, "i") },
    });
    if (category) resolvedCategoryId = category._id;
  }

  if (!resolvedCategoryId) {
    throw new ValidationError("Please choose an Urban Citation category for this business.", {
      requiresCategory: true,
      suggestedCategoryName: profile.category || null,
    });
  }

  const validSubCategoryIds = (Array.isArray(subCategoryIds) ? subCategoryIds : [])
    .filter((id) => mongoose.Types.ObjectId.isValid(id));
  if (validSubCategoryIds.length > 0) {
    const existing = await SubCategory.find({ _id: { $in: validSubCategoryIds } });
    if (existing.length !== validSubCategoryIds.length) {
      throw new ValidationError("One or more subcategories are invalid.");
    }
  }

  let media = {};
  if (accountName) {
    media = await googleBusinessService.fetchLocationMedia(user, accountName, locationName);
  }

  const { businessData, extra } = mapProfileToBusinessPayload(profile, user, {
    categoryId: resolvedCategoryId,
    subCategoryIds: validSubCategoryIds,
    media,
    accountName: media.accountVerified ? accountName : undefined,
  });

  let business;
  try {
    business = await businessService.createBusiness({
      ownerId: user._id,
      isAdmin: false,
      businessData,
      extra,
    });
  } catch (error) {
    // A database unique index is the final duplicate guard when two import
    // requests race between the lookup above and creation here.
    if (error?.code === 11000 && profile.businessId) {
      const raced = await Business.findOne({ googleLocationId: profile.businessId });
      if (raced && String(raced.userId || "") === String(user._id)) {
        return {
          business: await syncLinkedBusiness(raced, profile, media, {
            accountName: media.accountVerified ? accountName : undefined,
          }),
          created: false,
        };
      }
      if (raced) throw new LinkedToOtherAccountError(raced._id);
    }
    throw error;
  }

  logger.info("google_business.import.created", { userId: user._id, businessId: business._id, locationName });
  return { business, created: true };
}

module.exports = {
  ValidationError,
  NotAuthorizedError,
  LinkedToOtherAccountError,
  mapGoogleHoursToBusinessTiming,
  mapProfileToBusinessPayload,
  isStrongManualMatch,
  findLinkedBusiness,
  syncLinkedBusiness,
  importLocation,
};
