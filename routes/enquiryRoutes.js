const express = require('express');
const router = express.Router();
const {createEnquiry} = require('../controllers/enquiryController')
router.post('/enquiry', createEnquiry)

module.exports = router;