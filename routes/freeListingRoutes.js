const express = require('express');
const router = express.Router();
const {upload} = require('../config/multerConfig')
const {getFreeListing,createFreeListing}=require("../controllers/FreeListingController");

router.get('/freelisting', getFreeListing)
router.post('/freelisting', upload.single('icon'),createFreeListing)
module.exports = router;