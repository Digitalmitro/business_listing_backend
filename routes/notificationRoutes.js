const express = require('express');
const router = express.Router();
const {getNotifications} = require('../controllers/notificationController');

// Route to get notifications for a user
router.get('/notifications/:userId', getNotifications);

module.exports = router;
