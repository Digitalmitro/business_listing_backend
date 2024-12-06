const express = require('express');
const router = express.Router();
const {authMiddleware} =require('../middlewares/authMiddleware')
const {CreateQuestion} = require('../controllers/questionController')
router.post('/question',authMiddleware, CreateQuestion)
module.exports = router;