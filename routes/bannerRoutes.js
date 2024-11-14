const express = require('express');
const { createBanner, getAllBanners } = require('../controllers/bannerController');
const { upload } = require('../config/multerConfig');

const router = express.Router();

// Route to create a new banner
router.post('/banners', upload.single('image'), createBanner);

// Route to get all banners
router.get('/banners', getAllBanners);

module.exports = router;
