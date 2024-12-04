const express = require('express');
const router = express.Router();
const {authMiddleware}=require('../middlewares/authMiddleware.js')
const {createReview, getReviews} = require('../controllers/reviewController.js')

router.post('/reviews', authMiddleware,createReview);
router.get('/reviews/:businessId', getReviews)


module.exports = router;