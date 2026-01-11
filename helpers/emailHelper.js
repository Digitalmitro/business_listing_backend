const EmailTemplate = require("../models/EmailTemplate");

/**
 * Fetches an email template by trigger type and replaces placeholders.
 * @param {string} triggerType - The type of trigger (e.g., 'welcome', 'purchase').
 * @param {object} replacements - Key-value pairs of placeholders and their values.
 * @param {object} fallbacks - Fallback subject and body if template is not found.
 * @returns {Promise<{subject: string, html: string}>}
 */
async function getTemplate(triggerType, replacements = {}, fallbacks = {}) {
  const template = await EmailTemplate.findOne({ triggerType });

  let subject = template?.subject || fallbacks.subject || "";
  let html = template?.body || fallbacks.html || "";

  // Common replacements if not provided
  if (!replacements["{{frontend_url}}"]) {
    replacements["{{frontend_url}}"] = process.env.FRONTEND_URL || "https://urbancitations.com";
  }

  Object.entries(replacements).forEach(([key, value]) => {
    const val = value || "";
    html = html.split(key).join(val);
    subject = subject.split(key).join(val);
  });

  return { subject, html };
}

module.exports = { getTemplate };
