const Notification = require('../models/Notification');
const User = require('../models/User'); 

exports.createGlobalNotification = async (req, res) => {
  try {
    const { title, description } = req.body;
    if (!title || !description) {
      return res.status(400).json({ message: "Title and description are required" });
    }
    const users = await User.find({}, "_id");
    const userIds = users.map((user) => user._id);
    if (userIds.length === 0) {
      return res.status(404).json({ message: "No users found" });
    }
    const notifications = userIds.map((userId) => ({
      updateOne: {
        filter: { userId, title, description },
        update: {
          $setOnInsert: {
            userId,
            title,
            description,
            read: false,
            createdAt: new Date(),
          },
        },
        upsert: true,
      },
    }));
    await Notification.bulkWrite(notifications);
    res.status(200).json({ message: "Notifications sent to all users" });
  } catch (error) {
    console.error("Error creating global notification:", error);
    res.status(500).json({ message: "Server error" });
  }
};

exports.getNotifications = async (req, res) => {
  try {
    const userId = req.user.id;
    const notifications = await Notification.find({ userId })
      .sort({ createdAt: -1 }); 
    if (!notifications.length) {
      return res.status(404).json({ message: 'No notifications found.' });
    }
    res.status(200).json(notifications);
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};
