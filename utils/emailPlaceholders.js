const joinNames = (items) => (items || [])
  .map((item) => item?.name || item)
  .filter(Boolean)
  .join(", ");

const slugify = (value) => String(value || "business")
  .normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .trim()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "") || "business";

const getListingUrl = (business) => {
  if (!business?._id) return "";
  const frontendUrl = (process.env.FRONTEND_URL || "https://urbancitations.com").replace(/\/+$/, "");
  return `${frontendUrl}/${slugify(business.businessName)}/${business._id}`;
};

const getBusinessPlaceholderData = (business) => {
  if (!business) {
    return {
      business_name: "",
      address: "",
      website: "",
      phone: "",
      category: "",
      subcategory: "",
      country: "",
      listing_url: "",
    };
  }

  const address = business.address || {};
  const addressString = [
    address.blockName,
    address.streetName,
    address.area,
    address.landmark,
    address.city,
    address.state,
    address.pincode,
    address.country,
  ].filter(Boolean).join(", ");

  return {
    business_name: business.businessName || "",
    address: addressString,
    website: business.website || "",
    phone: business.contact?.mobile?.[0] || business.contact?.contactDetails?.[0]?.mobileNumbers?.[0] || "",
    category: joinNames(business.category),
    subcategory: joinNames(business.subCategory),
    country: address.country || "",
    listing_url: getListingUrl(business),
  };
};

const applyEmailPlaceholders = (template, data = {}) => {
  const values = {
    full_name: data.full_name || "User",
    frontend_url: data.frontend_url || process.env.FRONTEND_URL || "",
    package_name: data.package_name || "",
    start_date: data.start_date || "",
    business_id: data.business_id || "",
    status: data.status || "",
    rejection_reason: data.rejection_reason || "",
    business_name: data.business_name || "",
    address: data.address || "",
    website: data.website || "",
    email: data.email || "",
    phone: data.phone || "",
    category: data.category || "",
    category_name: data.category || data.category_name || "",
    subcategory: data.subcategory || "",
    subcategory_name: data.subcategory || data.subcategory_name || "",
    country: data.country || "",
    listing_url: data.listing_url || data.listingUrl || "",
  };

  return Object.entries(values).reduce(
    (output, [key, value]) => output.split(`{{${key}}}`).join(String(value)),
    String(template || "")
  );
};

module.exports = { applyEmailPlaceholders, getBusinessPlaceholderData, getListingUrl, slugify };
