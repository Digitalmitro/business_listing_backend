const mongoose = require('mongoose');

const NotificationSchema = new mongoose.Schema({
  recipientId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    refPath: 'recipientModel'
  },
  recipientModel: {
    type: String,
    required: true,
    enum: ['User', 'Admin'],
    default: 'User'
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
  link: {
    type: String,
    default: ""
  },
  category: {
    type: String,
    enum: ['business', 'claims', 'enquiry', 'kyc', 'subscription', 'general', 'booking'],
    default: 'general'
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
