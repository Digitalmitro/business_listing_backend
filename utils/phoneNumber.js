"use strict";

const {
  getCountries,
  parsePhoneNumberFromString,
  validatePhoneNumberLength,
} = require("libphonenumber-js/max");
const isoCountries = require("i18n-iso-countries");
const englishCountries = require("i18n-iso-countries/langs/en.json");

isoCountries.registerLocale(englishCountries);

const COUNTRY_ALIASES = {
  britain: "GB",
  england: "GB",
  india: "IN",
  uae: "AE",
  uk: "GB",
  "united kingdom": "GB",
  "united states": "US",
  "united states of america": "US",
  us: "US",
  usa: "US",
};

const LENGTH_MESSAGES = {
  TOO_SHORT: "Phone number is too short.",
  TOO_LONG: "Phone number is too long.",
};

function comparableCountryName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function resolveCountryCode(value) {
  const raw = String(value || "").trim();
  if (!raw) return undefined;

  const upper = raw.toUpperCase();
  if (getCountries().includes(upper)) return upper;

  const alias = COUNTRY_ALIASES[comparableCountryName(raw)];
  if (alias) return alias;

  const alpha2 = isoCountries.getAlpha2Code(raw, "en");
  return alpha2 && getCountries().includes(alpha2) ? alpha2 : undefined;
}

function phoneError(message, code, country) {
  return { valid: false, message, code, country };
}

function validatePhoneNumber(value, options = {}) {
  const { country, required = true, strictCountry = false } = options;
  const raw = String(value ?? "").trim();
  const defaultCountry = resolveCountryCode(country);

  if (!raw) {
    return required
      ? phoneError("Please enter a valid phone number.", "REQUIRED", defaultCountry)
      : { valid: true, e164: "", country: defaultCountry };
  }

  // Accept the commonly pasted international access prefix and normalize it.
  const candidate = raw.startsWith("00") ? `+${raw.slice(2)}` : raw;
  const lengthError = validatePhoneNumberLength(candidate, defaultCountry);
  if (LENGTH_MESSAGES[lengthError]) {
    return phoneError(LENGTH_MESSAGES[lengthError], lengthError, defaultCountry);
  }
  if (lengthError) {
    return phoneError(
      defaultCountry
        ? "Invalid phone number for the selected country."
        : "Please enter a valid phone number.",
      lengthError,
      defaultCountry,
    );
  }

  let parsed;
  try {
    parsed = parsePhoneNumberFromString(candidate, {
      defaultCountry,
      extract: false,
    });
  } catch {
    return phoneError("Please enter a valid phone number.", "MALFORMED", defaultCountry);
  }

  if (!parsed || !parsed.isValid()) {
    return phoneError(
      defaultCountry
        ? "Invalid phone number for the selected country."
        : "Please enter a valid phone number.",
      "INVALID_NUMBER",
      defaultCountry,
    );
  }

  if (strictCountry && defaultCountry && parsed.country && parsed.country !== defaultCountry) {
    return phoneError(
      "Invalid phone number for the selected country.",
      "COUNTRY_MISMATCH",
      defaultCountry,
    );
  }

  return {
    valid: true,
    e164: parsed.number,
    country: parsed.country,
    national: parsed.formatNational(),
    international: parsed.formatInternational(),
    type: parsed.getType(),
  };
}

class PhoneNumberValidationError extends Error {
  constructor(result) {
    super(result.message);
    this.name = "PhoneNumberValidationError";
    this.statusCode = 400;
    this.code = result.code;
    this.country = result.country;
  }
}

function normalizePhoneNumber(value, options = {}) {
  const result = validatePhoneNumber(value, options);
  if (!result.valid) throw new PhoneNumberValidationError(result);
  return result.e164;
}

function normalizePhoneNumbers(values, options = {}) {
  const numbers = Array.isArray(values) ? values : values == null ? [] : [values];
  return numbers
    .filter((value) => String(value ?? "").trim())
    .map((value) => normalizePhoneNumber(value, { ...options, required: true }));
}

function normalizeBusinessContact(contact = {}, country, options = {}) {
  const mobile = normalizePhoneNumbers(contact.mobile, { country });
  const whatsapp = normalizePhoneNumbers(contact.whatsapp, { country });
  const contactDetails = (Array.isArray(contact.contactDetails) ? contact.contactDetails : []).map(
    (detail) => ({
      ...detail,
      mobileNumbers: normalizePhoneNumbers(detail.mobileNumbers, { country }),
      whatsappNumbers: normalizePhoneNumbers(detail.whatsappNumbers, { country }),
    }),
  );

  const hasMobile = mobile.length > 0 || contactDetails.some((detail) => detail.mobileNumbers.length);
  if (options.requireMobile && !hasMobile) {
    throw new PhoneNumberValidationError(
      phoneError("Please enter a valid phone number.", "REQUIRED", resolveCountryCode(country)),
    );
  }

  return { ...contact, mobile, whatsapp, contactDetails };
}

module.exports = {
  PhoneNumberValidationError,
  normalizeBusinessContact,
  normalizePhoneNumber,
  normalizePhoneNumbers,
  resolveCountryCode,
  validatePhoneNumber,
};
