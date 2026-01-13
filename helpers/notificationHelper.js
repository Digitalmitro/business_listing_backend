const Notification = require("../models/Notification");
const Admin = require("../models/Admin");

const createNotification = async ({
  recipientId,
  recipientType = "User",
  title,
  description,
  image = "",
  link = "",
  category = "general",
}) => {
  try {
    const notification = new Notification({
      recipientId,
      recipientModel: recipientType,
      title,
      description,
      image: image || "https://urbancitations.com/logo.png", // Fallback logo
      link,
      category,
    });
    await notification.save();
    return notification;
  } catch (error) {
    console.error("Error creating notification:", error);
  }
};

const notifyAdmins = async ({ title, description, link = "", image = "", category = "general" }) => {
  try {
    const admins = await Admin.find({}, "_id");
    const notifications = admins.map((admin) => ({
      recipientId: admin._id,
      recipientModel: "Admin",
      title,
      description,
      link,
      image: image || "https://urbancitations.com/logo.png",
      category,
    }));

    if (notifications.length > 0) {
      await Notification.insertMany(notifications);
    }
  } catch (error) {
    console.error("Error notifying admins:", error);
  }
};

module.exports = {
  createNotification,
  notifyAdmins,
};
