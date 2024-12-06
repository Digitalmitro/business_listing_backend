const mongoose = require('mongoose');

const NotificationSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User', 
    required: true
  },
  image: {
    type: String, 
    default: "https://via.placeholder.com/50" 
  },
  title: {
    type: String, 
    required: true
  },
  description: {
    type: String, 
    required: true
  },
  read: {
    type: Boolean, 
    default: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

const Notification = mongoose.model('Notification', NotificationSchema);

module.exports = Notification;
