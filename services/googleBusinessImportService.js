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
const User = require("../models/User");
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
    super("This Google Business Profile is already linked to a listing in another UrbanCitations account. If you are an Owner of it on Google, you can move that listing into your account.");
    this.name = "LinkedToOtherAccountError";
    this.status = 409;
    this.existingBusinessId = existingBusinessId;
    this.claimable = true;
    this.canTakeOver = true;
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
const DAY_KEYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Validates a caller-supplied businessTiming ({ isOpen24Hours, daysOfWeek, schedule })
 * entered on the import review step when Google has no hours for the location.
 * Returns the normalized timing, or null when nothing usable was supplied.
 */
function normalizeManualTiming(input) {
  if (!input || typeof input !== "object") return null;
  if (input.isOpen24Hours === true) {
    const schedule = Object.fromEntries(DAY_KEYS.map((d) => [d, [{ openAt: "00:00", closeAt: "23:59" }]]));
    return { isOpen24Hours: true, daysOfWeek: [...DAY_KEYS], schedule };
  }
  const days = (Array.isArray(input.daysOfWeek) ? input.daysOfWeek : []).filter((d) => DAY_KEYS.includes(d));
  if (days.length === 0) return null;
  const schedule = {};
  for (const day of days) {
    const ranges = Array.isArray(input.schedule?.[day]) ? input.schedule[day] : [];
    const valid = ranges
      .filter((r) => r && TIME_RE.test(r.openAt || "") && TIME_RE.test(r.closeAt || "") && r.openAt < r.closeAt)
      .map((r) => ({ openAt: r.openAt, closeAt: r.closeAt }));
    if (valid.length === 0) {
      throw new ValidationError(`Enter a valid open and close time (HH:MM) for ${day}.`);
    }
    schedule[day] = valid;
  }
  return { isOpen24Hours: false, daysOfWeek: days, schedule };
}

function hasUsableTiming(timing) {
  return Boolean(timing && (timing.isOpen24Hours || (timing.daysOfWeek || []).length > 0));
}

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

function mapProfileToBusinessPayload(profile, user, { categoryId, subCategoryIds = [], media = {}, accountName, manualTiming = null } = {}) {
  const hasCoords = hasUsableCoordinates(profile);
  const regionName = countryNameFromRegionCode(profile.address?.country);
  const country = normalizeCountry(regionName || profile.address?.country || DEFAULT_COUNTRY);
  const googleTiming = mapGoogleHoursToBusinessTiming(profile.businessHours?.periods);
  // Google hours win; the review-step hours only fill the gap when Google has none.
  const timing = hasUsableTiming(googleTiming) ? googleTiming : manualTiming || googleTiming;
  const phones = [profile.phoneNumber, ...(profile.additionalPhones || [])].filter(Boolean);

  const businessData = {
    businessName: profile.businessName || "",
    address: {
      blockName: "",
      streetName: profile.address?.streetName || "",
      area: profile.address?.area || "",
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
    yearsOfEstablishment: profile.openingYear || undefined,
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

/**
 * The owner's existing listings that look like this Google location but weren't
 * matched strongly enough to link automatically: same or contained name, a shared
 * phone number, or the same city + pincode. Used to ask the owner instead of
 * silently creating a duplicate listing.
 */
async function findLinkCandidates(userId, profile) {
  const owned = await Business.find(
    { userId, googleLocationId: { $in: [null, ""] } },
    "_id businessName address contact location",
    { limit: 200, lean: true }
  );
  const googleName = normalizeMatchText(profile.businessName);
  const googlePhones = [profile.phoneNumber, ...(profile.additionalPhones || [])].map(normalizePhone).filter(Boolean);
  const googleCity = normalizeMatchText(profile.address?.city);
  const googlePin = normalizeMatchText(profile.address?.pincode);
  return owned
    .filter((b) => {
      const name = normalizeMatchText(b.businessName);
      const nameMatch = googleName && name && (name === googleName || name.includes(googleName) || googleName.includes(name));
      const phoneMatch = googlePhones.some((phone) => businessPhones(b).includes(phone));
      const placeMatch = googleCity && googlePin && normalizeMatchText(b.address?.city) === googleCity && normalizeMatchText(b.address?.pincode) === googlePin;
      return nameMatch || phoneMatch || placeMatch;
    })
    .map((b) => ({ _id: String(b._id), businessName: b.businessName, city: b.address?.city || "", area: b.address?.area || "" }));
}

/** Silver and higher include linking/syncing an existing listing with Google. */
async function assertGoogleIntegrationAllowed(business) {
  const plans = require("./planEntitlements");
  const { planName, entitlements } = await plans.getPlanEntitlements(business);
  if (!entitlements.googleBusiness) {
    throw Object.assign(new Error(`Connecting an existing listing to Google Business Profile is included from the Silver plan. "${business.businessName}" is on the ${planName} plan.`), {
      status: 403,
      code: "plan_required",
    });
  }
}

/**
 * Links an owner's existing listing to a Google location chosen by the owner and
 * fills in what the listing is missing (fill-only: the owner's own data is kept).
 */
async function linkExistingBusiness(user, businessId, profile, { accountName, locationName } = {}) {
  if (!mongoose.Types.ObjectId.isValid(businessId)) throw new ValidationError("Choose one of your businesses to link.");
  const target = await Business.findById(businessId);
  if (!target || String(target.userId || "") !== String(user._id)) {
    throw Object.assign(new Error("You can only link a Google profile to a business you own."), { status: 403 });
  }
  if (target.googleLocationId && profile.businessId && target.googleLocationId !== profile.businessId) {
    throw new ValidationError(`"${target.businessName}" is already linked to a different Google Business Profile location. Disconnect it first.`);
  }
  if (profile.businessId) {
    const other = await Business.findOne({ googleLocationId: profile.businessId, _id: { $ne: target._id } }).select("_id userId").lean();
    if (other) {
      if (String(other.userId || "") === String(user._id)) {
        throw new ValidationError("This Google location is already linked to another of your businesses.", { existingBusinessId: other._id });
      }
      throw new LinkedToOtherAccountError(other._id);
    }
  }
  await assertGoogleIntegrationAllowed(target);
  let media = {};
  if (accountName) media = await googleBusinessService.fetchLocationMedia(user, accountName, locationName);
  const synced = await syncLinkedBusiness(target, profile, media, { accountName: media.accountVerified ? accountName : undefined });
  logger.info("google_business.import.linked_existing", { userId: user._id, businessId: synced._id, locationName });
  return { business: synced, created: false, linked: true };
}

/**
 * Moves a listing that another UrbanCitations account linked to this Google location
 * into the requesting user's account. Allowed only when Google confirms the requester's
 * connected Google account is an Owner of the location (Managers must use the normal
 * claim review), and only when the owner explicitly asked for it (takeOver). The
 * bookkeeping mirrors an approved claim (claimController.updateClaimStatus).
 */
async function takeOverBusiness(user, business, profile, { accountName, locationName } = {}) {
  if (!(await googleBusinessService.isLocationOwner(user, locationName))) {
    throw Object.assign(
      new Error("Only an Owner of this Business Profile on Google can move it into your account. Your connected Google account is not an Owner of it — ask the Owner to make you one on Google, or submit a claim instead."),
      { status: 403, code: "google_owner_required", existingBusinessId: business._id, claimable: true }
    );
  }
  const previousOwnerId = business.userId;
  await assertGoogleIntegrationAllowed(business);

  business.userId = user._id;
  business.claimed = true;
  await business.save(); // syncLinkedBusiness only saves when Google changed a field
  let media = {};
  if (accountName) media = await googleBusinessService.fetchLocationMedia(user, accountName, locationName);
  const synced = await syncLinkedBusiness(business, profile, media, { accountName: media.accountVerified ? accountName : undefined });

  await User.updateMany({ businesses: business._id, _id: { $ne: user._id } }, { $pull: { businesses: business._id } });
  await User.updateOne({ _id: user._id }, { $addToSet: { businesses: business._id }, $set: { isSeller: true } });
  if (previousOwnerId && String(previousOwnerId) !== String(user._id)) {
    const stillOwnsAny = await Business.exists({ userId: previousOwnerId });
    if (!stillOwnsAny) await User.updateOne({ _id: previousOwnerId }, { $set: { isSeller: false } });
  }
  logger.warn("google_business.import.ownership_moved", {
    businessId: business._id,
    locationName,
    fromUserId: previousOwnerId,
    toUserId: user._id,
  });
  return { business: synced, created: false, linked: true, movedFromAnotherAccount: true };
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

/**
 * Copies a Google Business Profile into a linked UrbanCitations listing. Google is the
 * source of truth: every detail Google has (name, description, website, address,
 * coordinates, phones, hours, categories, opening year, Maps link, logo) replaces the
 * listing's value. Where Google has nothing, the listing keeps its own value, except on
 * listings that were created by a Google import, which mirror Google exactly. Nothing
 * the owner uploaded is lost: Google photos go in front of the owner's photos and
 * Google phone numbers are added to the owner's.
 */
async function syncLinkedBusiness(business, profile, media = {}, { accountName } = {}) {
  const mirrorGoogle = business.creationSource === "google_business";
  const has = (value) => !isUnset(value);
  const take = (googleValue, current, fallback = "") => (has(googleValue) ? googleValue : mirrorGoogle ? fallback : current);

  if (profile.businessId) business.googleLocationId = profile.businessId;
  if (accountName) business.googleAccountName = accountName;
  // Every caller has checked the listing belongs to this user, and Google only returned the
  // profile because their connected Google account manages it, so the listing is claimed.
  if (business.userId) business.claimed = true;

  business.businessName = take(profile.businessName, business.businessName, business.businessName);
  business.description = take(profile.description, business.description);
  business.website = take(profile.website, business.website);
  business.importedCategory = take(profile.category, business.importedCategory);
  if (profile.additionalCategories?.length || mirrorGoogle) business.servicesTypes = profile.additionalCategories || [];
  if (profile.openingYear) business.yearsOfEstablishment = profile.openingYear;
  if (profile.mapsUri) {
    const links = business.socialLinks instanceof Map ? business.socialLinks : new Map(Object.entries(business.socialLinks || {}));
    links.set("googleMaps", profile.mapsUri);
    business.socialLinks = links;
  }

  const addr = business.address ? business.address.toObject?.() || { ...business.address } : {};
  const g = profile.address || {};
  const googleCountry = g.country ? normalizeCountry(countryNameFromRegionCode(g.country) || g.country) : "";
  business.address = {
    ...addr,
    streetName: take(g.streetName, addr.streetName),
    area: take(g.area, addr.area),
    city: take(g.city, addr.city, DEFAULT_CITY),
    state: take(g.state, addr.state, DEFAULT_STATE),
    pincode: take(g.pincode, addr.pincode, DEFAULT_PINCODE),
    country: take(googleCountry, addr.country, normalizeCountry(DEFAULT_COUNTRY)),
  };

  const googlePhones = [profile.phoneNumber, ...(profile.additionalPhones || [])].filter(Boolean);
  business.contact = business.contact || {};
  const ownPhones = mirrorGoogle ? [] : business.contact.mobile || [];
  const phones = [...new Set([...googlePhones, ...ownPhones])];
  if (phones.length || mirrorGoogle) {
    business.contact.mobile = phones;
    const details = business.contact.contactDetails || [];
    if (details.length > 0) details[0].mobileNumbers = [...new Set([...googlePhones, ...(mirrorGoogle ? [] : details[0].mobileNumbers || [])])];
  }

  const googleTiming = mapGoogleHoursToBusinessTiming(profile.businessHours?.periods);
  if (hasUsableTiming(googleTiming) || mirrorGoogle) business.businessTiming = googleTiming;

  if (hasUsableCoordinates(profile)) {
    business.location = { type: "Point", coordinates: [profile.locationDetails.longitude, profile.locationDetails.latitude] };
    business.needsGeocoding = false;
  }

  if (media.logoUrl) business.businessLogo = media.logoUrl;
  if (media.photoUrls?.length) {
    const ownPhotos = mirrorGoogle ? [] : (business.photos || []).filter((photo) => photo && photo !== DEFAULT_PHOTO);
    business.photos = [...new Set([...media.photoUrls, ...ownPhotos])];
  }

  business.googleLastSyncedAt = new Date();
  await business.save();
  return business;
}

/**
 * Imports one Google Business Profile location, selected by the user, into UC as a
 * normal Business — creating it via the shared businessService.createBusiness() when
 * it does not already exist, or syncing an already-linked business owned by the same
 * user. Never trusts client-supplied profile data: the location is re-fetched from
 * Google with the user's own token, so Google itself is the authorization check.
 */
async function importLocation(
  user,
  { accountName, locationName, categoryId, subCategoryIds = [], businessTiming = null, linkBusinessId = null, createNew = false, takeOver = false } = {}
) {
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
    if (httpStatus === 404) throw new NotAuthorizedError();
    const googleError = googleBusinessService.toGoogleApiError(error);
    // A project-level problem (API off, permission unticked, not approved) is not the
    // user lacking access to this location, so keep Google's real cause for those.
    if (httpStatus === 403 && (!googleError || googleError.code === "google_forbidden")) {
      throw new NotAuthorizedError();
    }
    throw googleError || error;
  }

  // The owner chose which of their existing listings this Google location is.
  if (linkBusinessId) {
    return linkExistingBusiness(user, linkBusinessId, profile, { accountName, locationName });
  }

  const linked = await findLinkedBusiness(user._id, profile);
  if (linked) {
    if (String(linked.userId || "") === String(user._id)) {
      await assertGoogleIntegrationAllowed(linked);
      let media = {};
      if (accountName) {
        media = await googleBusinessService.fetchLocationMedia(user, accountName, locationName);
      }
      const verifiedAccountName = media.accountVerified ? accountName : undefined;
      const synced = await syncLinkedBusiness(linked, profile, media, { accountName: verifiedAccountName });
      return { business: synced, created: false };
    }
    if (takeOver) return takeOverBusiness(user, linked, profile, { accountName, locationName });
    throw new LinkedToOtherAccountError(linked._id);
  }

  // Don't silently create a second listing for a business the owner already has.
  if (!createNew) {
    const candidates = await findLinkCandidates(user._id, profile);
    if (candidates.length) {
      throw new ValidationError(
        "You already have a listing that looks like this Google Business Profile. Link it to keep your existing listing, or create a new one.",
        { requiresLinkChoice: true, candidates, googleBusinessName: profile.businessName || "" }
      );
    }
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

  // Bookings need opening hours. Google supplies them for most locations; when it
  // does not, the review step must collect them so no business is created without.
  const manualTiming = normalizeManualTiming(businessTiming);
  if (!hasUsableTiming(mapGoogleHoursToBusinessTiming(profile.businessHours?.periods)) && !manualTiming) {
    throw new ValidationError("Google has no opening hours for this location. Please enter the business hours before importing.", {
      requiresBusinessHours: true,
    });
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
    manualTiming,
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
    // The owner's own listing already uses this phone number: offer to link it.
    if (/numbers are already in use/i.test(error?.message || "")) {
      const candidates = await findLinkCandidates(user._id, profile);
      if (candidates.length) {
        throw new ValidationError(
          "One of your listings already uses this phone number. Link the Google profile to it instead of creating a duplicate.",
          { requiresLinkChoice: true, candidates, googleBusinessName: profile.businessName || "" }
        );
      }
    }
    throw error;
  }

  logger.info("google_business.import.created", { userId: user._id, businessId: business._id, locationName });
  return { business, created: true };
}

/** Upper bound per run so the OAuth callback redirect never waits on a huge account. */
const AUTO_IMPORT_LIMIT = 10;

/** Maps an importLocation failure to the per-location outcome the frontend shows. */
function autoImportFailure(error) {
  if (error.requiresLinkChoice) return { status: "needs_choice", message: error.message, candidates: error.candidates || [] };
  if (error.requiresCategory) return { status: "needs_category", message: error.message, suggestedCategoryName: error.suggestedCategoryName || null };
  if (error.requiresBusinessHours) return { status: "needs_hours", message: error.message };
  if (error.code === "plan_required") return { status: "plan_required", message: error.message };
  if (error.existingBusinessId) {
    return { status: "linked_elsewhere", message: error.message, existingBusinessId: String(error.existingBusinessId), canTakeOver: Boolean(error.canTakeOver) };
  }
  return { status: "failed", message: error.message };
}

/**
 * Merges every Business Profile location of the connected Google account into the
 * current user's UrbanCitations account, without asking, wherever the target is clear:
 *   - a location already linked to (or strongly matching) one of the user's listings is synced;
 *   - a location that looks like exactly one of the user's manually created listings is
 *     linked to it (fill-only: the owner's own details are kept, Google fills the gaps);
 *   - one Google location + one unlinked manual listing are merged with each other;
 *   - a location with no manual listing to merge into is created as a new listing.
 * Anything ambiguous (several possible listings, no category match, no opening hours,
 * plan limits, owned by another account) is reported back rather than guessed.
 */
async function autoImportAll(user) {
  let profiles;
  try {
    profiles = await googleBusinessService.fetchAllProfilesForUser(user);
  } catch (error) {
    throw googleBusinessService.toGoogleApiError(error) || error;
  }

  const unlinkedOwned = await Business.find(
    { userId: user._id, googleLocationId: { $in: [null, ""] } },
    "_id businessName address",
    { limit: 200, lean: true }
  );

  const results = [];
  for (const [index, profile] of profiles.entries()) {
    const base = { locationName: profile.businessId, accountName: profile.accountName, googleBusinessName: profile.businessName || "" };
    if (index >= AUTO_IMPORT_LIMIT) {
      results.push({ ...base, status: "skipped", message: "Open the Google import page to import the remaining locations." });
      continue;
    }
    try {
      let linkBusinessId = null;
      if (!(await findLinkedBusiness(user._id, profile))) {
        const candidates = await findLinkCandidates(user._id, profile);
        if (candidates.length === 1) {
          linkBusinessId = candidates[0]._id;
        } else if (!candidates.length && profiles.length === 1 && unlinkedOwned.length === 1) {
          linkBusinessId = String(unlinkedOwned[0]._id);
        } else if (candidates.length > 1 || unlinkedOwned.length > 0) {
          const options = candidates.length
            ? candidates
            : unlinkedOwned.map((b) => ({ _id: String(b._id), businessName: b.businessName, city: b.address?.city || "", area: b.address?.area || "" }));
          results.push({
            ...base,
            status: "needs_choice",
            message: "Choose which of your listings this Google location belongs to, or import it as a new listing.",
            candidates: options,
          });
          continue;
        }
      }
      const outcome = await importLocation(user, {
        accountName: profile.accountName,
        locationName: profile.businessId,
        linkBusinessId,
        createNew: !linkBusinessId,
      });
      results.push({
        ...base,
        status: outcome.created ? "created" : linkBusinessId ? "merged" : "synced",
        businessId: String(outcome.business._id),
        businessName: outcome.business.businessName,
      });
    } catch (error) {
      logger.warn("google_business.auto_import.location_failed", { userId: user._id, locationName: profile.businessId, error: error.message });
      results.push({ ...base, ...autoImportFailure(error) });
    }
  }

  const count = (status) => results.filter((r) => r.status === status).length;
  const summary = {
    total: results.length,
    merged: count("merged") + count("synced"),
    created: count("created"),
    pending: results.length - count("merged") - count("synced") - count("created"),
  };
  logger.info("google_business.auto_import.done", { userId: user._id, ...summary });
  return { summary, results };
}

module.exports = {
  ValidationError,
  autoImportAll,
  NotAuthorizedError,
  LinkedToOtherAccountError,
  mapGoogleHoursToBusinessTiming,
  mapProfileToBusinessPayload,
  isStrongManualMatch,
  findLinkedBusiness,
  findLinkCandidates,
  linkExistingBusiness,
  syncLinkedBusiness,
  takeOverBusiness,
  importLocation,
};
