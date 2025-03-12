const express = require('express');
const router = express.Router();
const {authMiddleware}= require('../middlewares/authMiddleware')
const {getAllplan} = require('../controllers/planController');
const { createPlan ,deletePlanById ,updatePlan } = require('../controllers/planController');

// POST API to create a new plan
router.post('/plansAdd', createPlan);

// Route to get notifications for a user
router.get('/plans', getAllplan );
router.delete("/:id",deletePlanById)
router.put("/:id", updatePlan);

module.exports = router;