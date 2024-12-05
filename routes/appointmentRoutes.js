const express = require('express');
const router = express.Router();
const {authMiddleware} = require('../middlewares/authMiddleware')
const {CreateAppointment, GetAppointment, CancelAppointment, RescheduleAppointment} = require('../controllers/appointmentController')

router.post('/appointment', authMiddleware, CreateAppointment)
router.get('/', authMiddleware, GetAppointment)
router.put('/', RescheduleAppointment)
router.put('/',CancelAppointment)

module.exports = router;