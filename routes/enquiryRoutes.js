const express = require('express');
const router = express.Router();
const {createEnquiry, getAllEnquiry, resloveEnquiry} = require('../controllers/enquiryController')
router.post('/enquiry', createEnquiry)
router.get('/enquiry', getAllEnquiry);
router.put("/enquiry/:id",resloveEnquiry)

module.exports = router;