const nodemailer = require('nodemailer');

/**
 * Sends an email using NodeMailer.
 * @param {string} to - Recipient email address.
 * @param {string} subject - Subject of the email.
 * @param {string} text - Body of the email.
 * @returns {Promise<object>} - Promise resolving to email send status.
 */

async function sendMail(to, subject, text) {
  try {
    const transporter = nodemailer.createTransport({
      service: 'Gmail',
      auth: {
        user: process.env.EMAIL_USER,  // Your Gmail address
        pass: process.env.EMAIL_PASS   // Your App Password
      }
    });

    const mailOptions = {
      from: process.env.EMAIL_USER,  
      to,                           
      subject,                     
      text                         
    };

    const info = await transporter.sendMail(mailOptions);
    return { success: true, info };
  } catch (error) {
    return { success: false, error };
  }
}

module.exports = sendMail;
