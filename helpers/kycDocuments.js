"use strict";

// Documents requested for KYC per country (same lists as the KYC and claim forms).
const KYC_REQUIRED_DOCS = {
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

module.exports = { KYC_REQUIRED_DOCS };
