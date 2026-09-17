// helpers/country.js
// Canonical country list + normalization, shared by manual business creation,
// CSV/XLSX import, and Google Business Profile import.

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

const VALID_COUNTRIES_MAP = new Map(VALID_COUNTRIES.map((c) => [c.toLowerCase(), c]));

const COUNTRY_ALIASES = {
  "USA": "United States",
  "U.S.A.": "United States",
  "U.S.": "United States",
  "US": "United States",
  "UNITED STATES": "United States",
  "UNITED STATES OF AMERICA": "United States",
  "UNITED STATESS": "United States",
  "UK": "United Kingdom",
  "U.K.": "United Kingdom",
  "GREAT BRITAIN": "United Kingdom",
  "ENGLAND": "United Kingdom",
  "UAE": "United Arab Emirates",
  "CANADA": "Canada",
  "INDIA": "India",
  "IN": "India",
  "BHARAT": "India",
};

/**
 * Normalizes a free-text country name (aliases, casing, ISO 3166-1 alpha-2 codes such
 * as "IN"/"US" that the customer form's location detection sends) to the canonical
 * VALID_COUNTRIES form. Unrecognised input is returned trimmed so callers can decide
 * what to do with it (see isKnownCountry).
 */
function normalizeCountry(c) {
  if (!c || typeof c !== "string") return "Unknown Country";
  const trimmed = c.trim().replace(/\s+/g, " ");
  if (!trimmed) return "Unknown Country";
  const upper = trimmed.toUpperCase();

  const aliased = COUNTRY_ALIASES[upper];
  if (aliased) return aliased;

  const standardName = VALID_COUNTRIES_MAP.get(trimmed.toLowerCase());
  if (standardName) return standardName;

  if (/^[A-Z]{2}$/.test(upper)) {
    const fromCode = countryNameFromRegionCode(upper);
    const codeName = fromCode && (COUNTRY_ALIASES[fromCode.toUpperCase()] || VALID_COUNTRIES_MAP.get(fromCode.toLowerCase()));
    if (codeName) return codeName;
  }

  return trimmed;
}

let regionCodeByName = null;
/** Lazily builds { canonical country name -> ISO alpha-2 code } from Intl region names. */
function getRegionCodeByName() {
  if (regionCodeByName) return regionCodeByName;
  const map = new Map();
  const display = getRegionDisplayNames();
  if (display) {
    for (let a = 65; a <= 90; a++) {
      for (let b = 65; b <= 90; b++) {
        const code = String.fromCharCode(a) + String.fromCharCode(b);
        let name = "";
        try { name = display.of(code); } catch { continue; }
        if (name && name !== code) {
          const canonical = COUNTRY_ALIASES[name.toUpperCase()] || VALID_COUNTRIES_MAP.get(name.toLowerCase());
          if (canonical && !map.has(canonical)) map.set(canonical, code);
        }
      }
    }
  }
  regionCodeByName = map;
  return map;
}

/**
 * Every stored spelling that should be treated as the given country: the canonical
 * name, its aliases and its ISO code. Lets list filters match rows that were saved
 * before values were normalized (for example "IN" or "usa").
 */
function countryMatchValues(c) {
  const canonical = normalizeCountry(c);
  const values = new Set([canonical]);
  for (const [alias, target] of Object.entries(COUNTRY_ALIASES)) {
    if (target === canonical) values.add(alias);
  }
  const code = getRegionCodeByName().get(canonical);
  if (code) values.add(code);
  return [...values];
}

/** True when the value is (after normalization) one of VALID_COUNTRIES. */
function isKnownCountry(c) {
  return VALID_COUNTRIES_MAP.has(normalizeCountry(c).toLowerCase());
}

let regionDisplayNames = null;
function getRegionDisplayNames() {
  if (regionDisplayNames === null) {
    try {
      regionDisplayNames = new Intl.DisplayNames(["en"], { type: "region" });
    } catch {
      regionDisplayNames = false;
    }
  }
  return regionDisplayNames || null;
}

/**
 * Converts an ISO 3166-1 alpha-2 region code (e.g. "IN", "US", as returned by
 * Google's `regionCode`) into a country name normalizeCountry() can standardize.
 * Returns "" when the code is missing/invalid so callers can fall back safely.
 */
function countryNameFromRegionCode(code) {
  if (!code || typeof code !== "string") return "";
  const display = getRegionDisplayNames();
  if (!display) return "";
  try {
    const name = display.of(code.trim().toUpperCase());
    return name && name !== code ? name : "";
  } catch {
    return "";
  }
}

module.exports = {
  VALID_COUNTRIES,
  normalizeCountry,
  isKnownCountry,
  countryMatchValues,
  countryNameFromRegionCode,
};
