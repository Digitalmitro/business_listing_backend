// backend/routes/authRoutes.js
const express = require('express');
const router = express.Router();
const {authMiddleware} = require('../middlewares/authMiddleware.js')
const { register, login, forgotPassword, googleLogin, getUserProfile } = require('../controllers/authController.js');

router.post('/register', register);
router.post('/login', login);
router.post('/google-login', googleLogin);
router.post('/forgot-password', forgotPassword);
router.get('/user-profile',authMiddleware, getUserProfile  )

module.exports = router;