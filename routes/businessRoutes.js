const express = require('express');
const { upload } = require('../config/multerConfig');
const {createBusiness,getBusiness} = require('../controllers/businessController')

const router = express.Router();

router.post('/businesses',upload.single('image'), createBusiness)
router.get('/businesses', getBusiness)

module.exports = router;
