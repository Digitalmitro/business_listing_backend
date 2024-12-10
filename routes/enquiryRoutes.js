const express = require('express');
const router = express.Router();
const {createEnquiry, getAllEnquiry} = require('../controllers/enquiryController')
router.post('/enquiry', createEnquiry)
router.get('/enquiry', getAllEnquiry)

module.exports = router;