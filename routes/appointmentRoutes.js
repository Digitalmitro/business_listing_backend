const express = require('express');
const router = express.Router();
const {authMiddleware} = require('../middlewares/authMiddleware')
const {CreateAppointment, GetAppointment, CancelAppointment, RescheduleAppointment} = require('../controllers/appointmentController')

router.post('/appointment', authMiddleware, CreateAppointment)
router.get('/appointment', authMiddleware, GetAppointment)
router.put('/appointment/:appointmentId', RescheduleAppointment)
router.patch('/appointment/:appointmentId',CancelAppointment)

module.exports = router;