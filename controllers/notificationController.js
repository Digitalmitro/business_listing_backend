const Notification = require('../models/Notification');
const User = require('../models/User'); 

exports.createGlobalNotification = async (req, res) => {
  try {
    const { title, description, link, image } = req.body;
    if (!title || !description) {
      return res.status(400).json({ message: "Title and description are required" });
    }
    const users = await User.find({}, "_id");
    const userIds = users.map((user) => user._id);
    if (userIds.length === 0) {
      return res.status(404).json({ message: "No users found" });
    }
    const notifications = userIds.map((userId) => ({
      recipientId: userId,
      recipientModel: 'User',
      title,
      description,
      link: link || "",
      image: image || "https://via.placeholder.com/50",
      read: false,
      createdAt: new Date(),
    }));
    await Notification.insertMany(notifications);
    res.status(200).json({ message: "Notifications sent to all users" });
  } catch (error) {
    console.error("Error creating global notification:", error);
    res.status(500).json({ message: "Server error" });
  }
};

exports.getNotifications = async (req, res) => {
  try {
    const recipientId = req.user.id;
    const notifications = await Notification.find({ recipientId })
      .sort({ createdAt: -1 }); 
    
    res.status(200).json(notifications);
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

exports.markAsRead = async (req, res) => {
  try {
    const { notificationId } = req.params;
    await Notification.findByIdAndUpdate(notificationId, { read: true });
    res.status(200).json({ success: true, message: "Notification marked as read" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.markAllAsRead = async (req, res) => {
  try {
    const recipientId = req.user.id;
    await Notification.updateMany({ recipientId, read: false }, { read: true });
    res.status(200).json({ success: true, message: "All notifications marked as read" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.deleteNotification = async (req, res) => {
  try {
    const { notificationId } = req.params;
    await Notification.findByIdAndDelete(notificationId);
    res.status(200).json({ success: true, message: "Notification deleted" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.getNotificationCounts = async (req, res) => {
  try {
    const recipientId = req.user.id;
    
    // Get unread counts grouped by category
    const counts = await Notification.aggregate([
      { 
        $match: { 
          recipientId: new require('mongoose').Types.ObjectId(recipientId), 
          read: false 
        } 
      },
      {
        $group: {
          _id: "$category",
          count: { $sum: 1 }
        }
      }
    ]);

    // Convert to object format
    const countsByCategory = counts.reduce((acc, item) => {
      acc[item._id] = item.count;
      return acc;
    }, {});

    // Calculate total
    const total = counts.reduce((sum, item) => sum + item.count, 0);

    res.status(200).json({ 
      success: true, 
      total,
      counts: countsByCategory 
    });
  } catch (error) {
    console.error('Error fetching notification counts:', error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};
