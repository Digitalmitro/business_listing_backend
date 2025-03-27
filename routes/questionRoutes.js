const express = require('express');
const router = express.Router();
const {authMiddleware} =require('../middlewares/authMiddleware')
const {CreateQuestion, getAllQuestion,replyAnswer} = require('../controllers/questionController')
router.post('/question',authMiddleware, CreateQuestion)
router.get('/question', getAllQuestion);
router.put('/question/:id',replyAnswer)
module.exports = router;