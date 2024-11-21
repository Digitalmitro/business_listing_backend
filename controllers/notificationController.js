const Notification = require('../models/Notification');
const User = require('../models/User'); // Assuming you have a User model to verify admin

exports.createGlobalNotification = async (req, res) => {
  try {
    const adminUser = await User.findById(req.userId); 
    if (!adminUser || !adminUser.isAdmin) {
      return res.status(403).json({ message: 'You are not authorized to create global notifications.' });
    }
    const { message } = req.body;
    const globalNotification = new Notification({
      message,
      global: true,
    });
    await globalNotification.save();
    const users = await User.find();
    const notificationsForUsers = users.map(user => {
      return new Notification({
        userId: user._id,
        message,
        global: true,
      });
    });
    await Notification.insertMany(notificationsForUsers);
    res.status(201).json({ message: 'Global notification created and sent to all users.' });
  } catch (error) {
    console.error('Error creating global notification:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

exports.getNotifications = async (req, res) => {
  try {
    const userId = req.params.userId;
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
