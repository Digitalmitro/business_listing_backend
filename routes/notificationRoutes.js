const express = require('express');
const router = express.Router();
const {authMiddleware}= require('../middlewares/authMiddleware')
const {
  getNotifications,
  createGlobalNotification,
  markAsRead,
  markAllAsRead,
  deleteNotification,
} = require("../controllers/notificationController");

// Route to get notifications for a user/admin
router.get("/notifications", authMiddleware, getNotifications);
router.post("/create-notification", createGlobalNotification);
router.put("/notifications/mark-read/:notificationId", authMiddleware, markAsRead);
router.put("/notifications/mark-all-read", authMiddleware, markAllAsRead);
router.delete("/notifications/:notificationId", authMiddleware, deleteNotification);

module.exports = router;
