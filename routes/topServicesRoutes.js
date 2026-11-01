const express = require('express');
const router = express.Router();
const {upload} = require('../config/multerConfig')
const { requireAdmin } = require('../middlewares/requireAdmin')
const {getTopServices,createTopServices}=require("../controllers/topServices")

router.get('/top-services', getTopServices)
router.post('/top-services', requireAdmin('cms'), upload.single('icon'),createTopServices)

module.exports = router;