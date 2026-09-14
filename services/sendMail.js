const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

let transporter = null;

/**
 * Lazily builds a single Gmail SMTP transporter from EMAIL_USER / EMAIL_PASS.
 * Throws a descriptive error when the credentials are missing or still placeholders,
 * so a misconfigured server fails loudly instead of silently "sending" nothing.
 */
function getTransporter() {
  const user = String(process.env.EMAIL_USER || '').trim();
  const pass = String(process.env.EMAIL_PASS || '').trim();
  const looksLikePlaceholder = (v) => !v || /^<.*>$/.test(v) || /^your_/i.test(v);
  if (looksLikePlaceholder(user) || looksLikePlaceholder(pass)) {
    throw new Error('EMAIL_USER / EMAIL_PASS are not configured (set a Gmail address and a 16-character App Password)');
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'Gmail',
      auth: { user, pass },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
  }
  return transporter;
}

/**
 * Sends a plain-text (and optional HTML) email through Gmail SMTP.
 * @param {string} to - Recipient email address.
 * @param {string} subject - Subject of the email.
 * @param {string} text - Plain-text body. If it contains HTML tags it is also sent as HTML.
 * @returns {Promise<{success: boolean, info?: object, error?: Error}>}
 *   Callers MUST check `.success`; the returned object is always truthy.
 */
async function sendMail(to, subject, text) {
  try {
    const mailer = getTransporter();
    const mailOptions = {
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      to,
      subject,
      text: String(text || '').replace(/<[^>]+>/g, ''),
    };
    if (/<[a-z][\s\S]*>/i.test(String(text || ''))) mailOptions.html = text;

    const info = await mailer.sendMail(mailOptions);
    logger.info('sendMail.sent', 'Email sent', { to, subject, messageId: info.messageId, response: info.response });
    return { success: true, info };
  } catch (error) {
    logger.error('sendMail.failed', 'Error sending email', {
      to,
      subject,
      error: error.message,
      code: error.code,
      responseCode: error.responseCode,
      smtpResponse: error.response,
    });
    return { success: false, error };
  }
}

/** Verifies SMTP credentials without sending anything. */
async function verifyMailer() {
  const mailer = getTransporter();
  await mailer.verify();
  return true;
}

module.exports = sendMail;
module.exports.sendMail = sendMail;
module.exports.verifyMailer = verifyMailer;
