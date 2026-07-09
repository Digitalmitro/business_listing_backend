const express = require('express');
const router = express.Router();
const {authMiddleware}= require('../middlewares/authMiddleware')
const {
  getNotifications,
  createGlobalNotification,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  getNotificationCounts,
} = require("../controllers/notificationController");

// Keep the collection-style and legacy singular endpoints in sync.
router.get("/", authMiddleware, getNotifications);
router.get("/notifications", authMiddleware, getNotifications);
router.get("/counts", authMiddleware, getNotificationCounts);
router.get("/notification-counts", authMiddleware, getNotificationCounts);
router.post("/create-notification", createGlobalNotification);
router.put("/mark-read/:notificationId", authMiddleware, markAsRead);
router.put("/notifications/mark-read/:notificationId", authMiddleware, markAsRead);
router.put("/mark-all-read", authMiddleware, markAllAsRead);
router.put("/notifications/mark-all-read", authMiddleware, markAllAsRead);
router.delete("/:notificationId", authMiddleware, deleteNotification);
router.delete("/notifications/:notificationId", authMiddleware, deleteNotification);

module.exports = router;
