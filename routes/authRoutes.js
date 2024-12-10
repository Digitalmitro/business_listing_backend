// backend/routes/authRoutes.js
const express = require('express');
const router = express.Router();
const {authMiddleware} = require('../middlewares/authMiddleware.js')
const { upload } = require('../config/multerConfig');
const { register, login, forgotPassword, googleLogin, getUserProfile, getAllUsers, updateUserProfile } = require('../controllers/authController.js');

router.post('/register', register);
router.post('/login', login);
router.post('/google-login', googleLogin);
router.post('/forgot-password', forgotPassword);
router.get('/user-profile',authMiddleware, getUserProfile  )
router.put('/update-profile', authMiddleware,upload.single('image'),updateUserProfile )
//use for admin
router.get('/get-all-user',getAllUsers )

module.exports = router;