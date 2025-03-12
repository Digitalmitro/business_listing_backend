const express = require('express');
const { createTopBannerCategory, getAllTopBannerCategories } = require('../controllers/topBannerCategoryController');
// const { upload } = require('../config/multerConfig');
const { upload }=require("../config/Cloudinary")

const router = express.Router();

// Route to create a new top banner category
router.post('/top-banner-category', upload.single('image'), createTopBannerCategory);

// Route to get all top banner categories
router.get('/top-banner-category', getAllTopBannerCategories);

module.exports = router;
