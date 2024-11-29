const express = require('express');
const { upload } = require('../config/multerConfig');
const {createBusiness,getBusiness, searchServices, blockBusiness, deleteBusiness} = require('../controllers/businessController')
const {authMiddleware} = require('../middlewares/authMiddleware')

const router = express.Router();

router.post('/businesses', upload.single('image'), createBusiness)
router.get('/businesses', getBusiness)
router.get('/search', searchServices)
router.patch('/block/:businessId',blockBusiness)
router.delete('/delete/:businessId', deleteBusiness)

module.exports = router;
