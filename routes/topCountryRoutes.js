const express = require('express');
const router = express.Router();
const {upload} = require('../config/multerConfig')
const {createTopcountry, getTopcountry} = require('../controllers/topCountryController')

router.post('/top-country', upload.single('icon'),createTopcountry)
router.get('/top-country', getTopcountry)

module.exports = router;