#!/usr/bin/env node
/**
 * Verifies the Gmail SMTP credentials used for admin OTP emails and optionally sends a test mail.
 *   node scripts/checkMailer.js                 # verify credentials only
 *   node scripts/checkMailer.js you@example.com # verify and send a test email
 */
require("dotenv").config();
const sendMail = require("../services/sendMail");

(async () => {
  const user = process.env.EMAIL_USER || "";
  console.log(`EMAIL_USER = ${user || "(missing)"}`);
  console.log(`EMAIL_PASS = ${process.env.EMAIL_PASS ? `set (${process.env.EMAIL_PASS.replace(/\s/g, "").length} chars)` : "(missing)"}`);
  try {
    await sendMail.verifyMailer();
    console.log("SMTP login OK");
  } catch (err) {
    console.error("SMTP login FAILED:", err.message);
    if (err.responseCode === 535 || /Invalid login|BadCredentials/i.test(err.message)) {
      console.error("Gmail rejected the credentials. Use a 16-character App Password (Google Account > Security > 2-Step Verification > App passwords), not the account password.");
    }
    process.exit(1);
  }
  const to = process.argv[2];
  if (to) {
    const result = await sendMail(to, "UrbanCitations mailer test", "If you can read this, OTP emails will work.");
    console.log(result.success ? `Test email sent to ${to}: ${result.info.response}` : `Test email FAILED: ${result.error.message}`);
    process.exit(result.success ? 0 : 1);
  }
  process.exit(0);
})();
