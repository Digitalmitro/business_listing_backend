const express = require('express');
const { createBanner, getAllBanners } = require('../controllers/bannerController');
// const { upload } = require('../config/multerConfig');
const upload = require('../middlewares/uploadMiddleware')

const router = express.Router();

// Route to create a new banner
router.post('/banners', upload.fields([{ name: 'image', maxCount: 1 }]), createBanner);

// Route to get all banners
router.get('/banners', getAllBanners);

module.exports = router;
