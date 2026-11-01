const { Worker } = require("bullmq");
const { redisConnection } = require("../utils/queue");
const { sendMail } = require("../utils/nodemailer");
const User = require("../models/User");
const Business = require("../models/Business");
const Claim = require("../models/Claim");
const SenderEmail = require("../models/SenderEmail");
const { getTemplate } = require("../helpers/emailHelper");

const box = (inner) =>
  `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">${inner}<br><p>Best Regards,<br>The UrbanCitations Team</p></div>`;

/**
 * A claim was just submitted: confirm receipt to the claimant, and tell the
 * business's current owner (if any, and not the claimant) that someone claimed it.
 */
async function sendClaimSubmittedEmails({ claim, user, sender }) {
  const received = await getTemplate(
    "claim_received",
    { "{{full_name}}": user.full_name, "{{business_name}}": claim.businessName },
    {
      subject: "We received your business claim - UrbanCitations",
      html: box(`<h2 style="color:#0b6bcb;">Claim received</h2><p>Hi {{full_name}},</p>
        <p>We received your request to claim <strong>{{business_name}}</strong>. Our team will review your documents and email you the decision.</p>`),
    }
  );
  const r1 = await sendMail(sender.email, user.email, received.subject, received.html);
  if (!r1.success) throw new Error(`Failed to send claim receipt: ${r1.error.message}`);

  const business = await Business.findById(claim.businessId).select("userId businessName").lean();
  if (business?.userId && String(business.userId) !== String(user._id)) {
    const owner = await User.findById(business.userId).select("full_name email").lean();
    if (owner?.email) {
      const notice = await getTemplate(
        "claim_owner_notice",
        { "{{full_name}}": owner.full_name || "there", "{{business_name}}": business.businessName },
        {
          subject: "Someone has claimed your business on UrbanCitations",
          html: box(`<h2 style="color:#F59E0B;">Ownership claim submitted</h2><p>Hi {{full_name}},</p>
            <p>Someone has asked to claim <strong>{{business_name}}</strong>, which is currently managed by your account. Our team reviews every claim and its documents before any change.</p>
            <p>If you did not expect this, reply to this email or contact support so we can take it into account.</p>`),
        }
      );
      const r2 = await sendMail(sender.email, owner.email, notice.subject, notice.html);
      if (!r2.success) throw new Error(`Failed to send claim notice to the owner: ${r2.error.message}`);
    }
  }
}

const claimWorker = new Worker(
  "claim-email",
  async (job) => {
    const { claimId, status } = job.data;
    try {
      const claim = await Claim.findById(claimId).populate("userId");
      if (!claim) {
        throw new Error("Claim not found");
      }

      const user = claim.userId;
      if (!user) {
        throw new Error("User not found for claim");
      }

      const sender = await SenderEmail.findOne({ isActive: true });
      if (!sender) {
        throw new Error("No active sender email found");
      }

      if (status === "submitted") {
        await sendClaimSubmittedEmails({ claim, user, sender });
        return;
      }

      const isApproved = status === "approved";
      const triggerType = isApproved ? "claim_approved" : "claim_rejected";

      const { subject, html } = await getTemplate(
        triggerType,
        {
          "{{full_name}}": user.full_name,
          "{{business_name}}": claim.businessName,
          "{{business_id}}": claim.businessId,
          "{{status}}": status,
        },
        {
          subject: `Business Claim ${isApproved ? "Approved" : "Rejected"} - UrbanCitations`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
              <h2 style="color: ${isApproved ? "#4CAF50" : "#F44336"};">Claim ${isApproved ? "Approved" : "Rejected"}</h2>
              <p>Hi {{full_name}},</p>
              <p>Your request to claim the business <strong>{{business_name}}</strong> has been <strong>{{status}}</strong> by our team.</p>
              
              ${isApproved 
                ? `<p>You now have full access to manage this business listing from your dashboard.</p>
                   <div style="text-align: center; margin: 30px 0;">
                     <a href="{{frontend_url}}/dashboard" style="background-color: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">Go to Dashboard</a>
                   </div>`
                : `<p>Unfortunately, we could not verify your ownership of this business. If you believe this is a mistake, please reach out to our support team with additional documentation.</p>`
              }
              
              <p>If you have any questions, feel free to contact us.</p>
              <br>
              <p>Best Regards,<br>The UrbanCitations Team</p>
            </div>
          `,
        }
      );

      // Transactional: no unsubscribe link (the old one pointed at a page the site never had).
      const result = await sendMail(sender.email, user.email, subject, html);

      if (!result.success) {
        throw new Error(`Failed to send claim email: ${result.error.message}`);
      }

      console.log(`Claim ${status} email sent to ${user.email} for business ${claim.businessName}`);
    } catch (error) {
      console.error(`Error in claimWorker for job ${job.id}:`, error);
      throw error;
    }
  },
  { connection: redisConnection }
);

module.exports = claimWorker;
