const Notification = require('../models/Notification');
const User = require('../models/User'); 

exports.createGlobalNotification = async (req, res) => {
  try {
    // const adminId = req.admin.id
    const { title, description, timeAgo } = req.body;
    const users = await User.find({}, "_id"); 
    const userIds = users.map(user => user._id);

    const notifications = userIds.map(userId => {
      return {
        updateOne: {
          filter: { userId }, 
          update: {
            $setOnInsert: {
              userId,
              title,
              description,
              timeAgo,
              read: false,
              createdAt: new Date(),
            }
          },
          upsert: true, 
        }
      };
    });

    if (notifications.length > 0) {
      await Notification.bulkWrite(notifications);
      return res.status(200).json({ message: 'Notifications sent to all users' });
    }

    return res.status(400).json({ message: 'No users found' });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Server error' });
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
