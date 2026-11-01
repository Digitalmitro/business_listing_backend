const express = require('express');
const router = express.Router();
const {authMiddleware} =require('../middlewares/authMiddleware')
const { requireAdmin } = require('../middlewares/requireAdmin')
const {CreateQuestion, getAllQuestion,replyAnswer} = require('../controllers/questionController')
router.post('/question',authMiddleware, CreateQuestion)
// Public, but a request carrying a token is authenticated so admins get the full view.
const optionalAuth = (req, res, next) => (req.header('Authorization') ? authMiddleware(req, res, next) : next());
router.get('/question', optionalAuth, getAllQuestion);
router.put('/question/:id', authMiddleware, requireAdmin('questions'), replyAnswer)
module.exports = router;