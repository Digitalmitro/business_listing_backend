const Notification = require('../models/Notification');
const User = require('../models/User'); // Assuming you have a User model to verify admin

// Admin creates a global notification
exports.createGlobalNotification = async (req, res) => {
  try {
    // Check if the user making the request is an admin
    const adminUser = await User.findById(req.userId);  // Assuming req.userId contains the ID of the logged-in user
    if (!adminUser || !adminUser.isAdmin) {
      return res.status(403).json({ message: 'You are not authorized to create global notifications.' });
    }

    const { message } = req.body;

    // Create a global notification
    const globalNotification = new Notification({
      message,
      global: true,
    });

    // Save the notification
    await globalNotification.save();

    // Fetch all users and create a notification for each
    const users = await User.find();
    const notificationsForUsers = users.map(user => {
      return new Notification({
        userId: user._id,
        message,
        global: true,
      });
    });

    // Save notifications for each user
    await Notification.insertMany(notificationsForUsers);

    res.status(201).json({ message: 'Global notification created and sent to all users.' });
  } catch (error) {
    console.error('Error creating global notification:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};


// Controller to handle getting notifications for a user
exports.getNotifications = async (req, res) => {
  try {
    const userId = req.params.userId;
    
    // Fetch the notifications for the user, sorted by most recent
    const notifications = await Notification.find({ userId })
      .sort({ createdAt: -1 }); // Sort by creation date, most recent first
    
    if (!notifications.length) {
      return res.status(404).json({ message: 'No notifications found.' });
    }

    res.status(200).json(notifications);
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};
