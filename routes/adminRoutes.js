const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const {authMiddleware} = require('../middlewares/authMiddleware')

// Admin login route
router.post('/login', adminController.login);
router.post('/register', adminController.register)
router.get('/getalluserAndseller',authMiddleware, adminController.getAlluserAndseller);
router.post("/verify-otp", adminController.verifyOtp);

module.exports = router;
