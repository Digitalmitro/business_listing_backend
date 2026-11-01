const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { updateFooterLinks } = require('../controllers/footerController');
const {authMiddleware} = require('../middlewares/authMiddleware');
const { requireAdmin, requireSuperAdmin } = require('../middlewares/requireAdmin');

// Auth routes
router.post('/login', adminController.login);
// Creating admins is a super-admin action (there is no public sign-up; seed the first
// super-admin with scripts/seedAdmins.js).
router.post('/register', authMiddleware, requireSuperAdmin, adminController.register);
router.post("/verify-otp", adminController.verifyOtp);
router.post('/forgot-password', adminController.forgotPassword);
router.post('/reset-password', adminController.resetPassword);

// Admin Profile & Dashboard
router.get('/profile', authMiddleware, requireAdmin(), adminController.getAdminProfile);
router.put('/update-profile', authMiddleware, requireAdmin(), adminController.updateProfile);
router.get('/getalluserAndseller', authMiddleware, requireAdmin(), adminController.getAlluserAndseller);

// Sub-Admin Management (Super-Admin only)
router.post('/create-subadmin', authMiddleware, requireSuperAdmin, adminController.createSubAdmin);
router.get('/all-admins', authMiddleware, requireSuperAdmin, adminController.getAllAdmins);
router.put('/update-subadmin/:id', authMiddleware, requireSuperAdmin, adminController.updateSubAdmin);
router.delete('/delete-subadmin/:id', authMiddleware, requireSuperAdmin, adminController.deleteSubAdmin);

// Other administrative tasks
router.put("/update-footer", authMiddleware, requireAdmin("cms"), updateFooterLinks);

module.exports = router;
