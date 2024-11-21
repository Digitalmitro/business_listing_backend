const express = require('express');
const router = express.Router();
const {authMiddleware}= require('../middlewares/authMiddleware')
const {getAllplan} = require('../controllers/planController')
// Route to get notifications for a user
router.get('/plans', getAllplan );
// router.post('/plans', )

module.exports = router;