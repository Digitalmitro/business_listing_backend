const express = require('express');
const { upload } = require('../config/multerConfig');
const {createBusiness,getBusiness, searchServices} = require('../controllers/businessController')

const router = express.Router();

router.post('/businesses',upload.single('image'), createBusiness)
router.get('/businesses', getBusiness)
router.get('/search', searchServices)

module.exports = router;
