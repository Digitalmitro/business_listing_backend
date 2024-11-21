const express = require('express');
const router = express.Router();
const {authMiddleware}= require('../middlewares/authMiddleware')
const {getNotifications} = require('../controllers/notificationController');

// Route to get notifications for a user
router.get('/notifications',authMiddleware, getNotifications);
router.post('/create-notification', )

module.exports = router;
