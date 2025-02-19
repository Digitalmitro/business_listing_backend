const express = require('express');
const router = express.Router();
const {upload} = require('../config/multerConfig')
const {getTopServices,createTopServices}=require("../controllers/topServices")

router.get('/top-services', getTopServices)
router.post('/top-services', upload.single('icon'),createTopServices)

module.exports = router;