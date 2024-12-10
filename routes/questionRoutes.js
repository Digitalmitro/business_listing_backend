const express = require('express');
const router = express.Router();
const {authMiddleware} =require('../middlewares/authMiddleware')
const {CreateQuestion, getAllQuestion} = require('../controllers/questionController')
router.post('/question',authMiddleware, CreateQuestion)
router.get('/question', getAllQuestion)
module.exports = router;