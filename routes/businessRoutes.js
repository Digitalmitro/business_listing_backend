const express = require('express');
const { upload } = require('../config/multerConfig');
const {createBusiness,getBusiness, searchServices, blockBusiness, deleteBusiness, updateBusiness, getuserBusiness, getAllBusiness} = require('../controllers/businessController')
const {authMiddleware} = require('../middlewares/authMiddleware')

const router = express.Router();

router.post('/businesses', upload.single('image'),authMiddleware, createBusiness)
router.post('/all-business', getAllBusiness)
router.put('/update-business', updateBusiness)
router.get('/businesses', getBusiness)
router.get('/user-business', authMiddleware, getuserBusiness)
router.get('/search', searchServices)
router.patch('/block/:businessId',blockBusiness)
router.delete('/delete/:businessId', deleteBusiness)

module.exports = router;
