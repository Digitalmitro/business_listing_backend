const express = require('express');
const { createCategory, getAllCategories } = require('../controllers/categoryController');
const { upload } = require('../config/multerConfig');

const router = express.Router();

router.post('/categories', upload.fields([
    { name: 'icon', maxCount: 1 }, 
    { name: 'bgImage', maxCount: 1 } ]),createCategory);

router.get('/categories', getAllCategories);

module.exports = router;
