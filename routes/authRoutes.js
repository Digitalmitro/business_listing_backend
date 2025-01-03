// backend/routes/authRoutes.js
const express = require('express');
const router = express.Router();
const {authMiddleware} = require('../middlewares/authMiddleware.js')
// const { upload } = require('../config/multerConfig');
const upload = require('../middlewares/uploadMiddleware')
const { register, login, forgotPassword, googleLogin, getUserProfile, getAllUsers, updateUserProfile, sendOTP } = require('../controllers/authController.js');

router.post('/register', register);
router.post('/login', login);
router.post('/google-login', googleLogin);
router.post('/forgot-password', forgotPassword);
router.post('/sendOtp', sendOTP)
router.get('/user-profile',authMiddleware, getUserProfile  )
router.put('/update-profile', authMiddleware, upload.fields([{ name: 'image', maxCount: 1 }]), updateUserProfile )
//use for admin
router.get('/get-all-user',getAllUsers )

module.exports = router;