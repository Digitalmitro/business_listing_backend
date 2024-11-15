const express = require('express');
const { createCategory, getAllCategories } = require('../controllers/categoryController');
const { upload } = require('../config/multerConfig');

const router = express.Router();

router.post('/categories', createCategory);
router.get('/categories', getAllCategories);

module.exports = router;
