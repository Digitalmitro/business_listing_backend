const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { updateFooterLinks } = require('../controllers/footerController');
const {authMiddleware} = require('../middlewares/authMiddleware');

// Auth routes
router.post('/login', adminController.login);
router.post('/register', adminController.register);
router.post("/verify-otp", adminController.verifyOtp);
router.post('/forgot-password', adminController.forgotPassword);
router.post('/reset-password', adminController.resetPassword);

// Admin Profile & Dashboard
router.get('/profile', authMiddleware, adminController.getAdminProfile);
router.put('/update-profile', authMiddleware, adminController.updateProfile);
router.get('/getalluserAndseller', authMiddleware, adminController.getAlluserAndseller);

// Sub-Admin Management (Super-Admin only)
router.post('/create-subadmin', authMiddleware, adminController.createSubAdmin);
router.get('/all-admins', authMiddleware, adminController.getAllAdmins);
router.put('/update-subadmin/:id', authMiddleware, adminController.updateSubAdmin);
router.delete('/delete-subadmin/:id', authMiddleware, adminController.deleteSubAdmin);

// Other administrative tasks
router.put("/update-footer", authMiddleware, updateFooterLinks);

module.exports = router;
