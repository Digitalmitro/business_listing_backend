const express = require('express');
const router = express.Router();
const {authMiddleware}= require('../middlewares/authMiddleware')
const { requireAdmin } = require("../middlewares/requireAdmin");
const {getAllplan} = require('../controllers/planController');
const { createPlan ,deletePlanById ,updatePlan } = require('../controllers/planController');

// POST API to create a new plan
router.post('/plansAdd', authMiddleware, requireAdmin('packages'), createPlan);

// Route to get notifications for a user
router.get('/plans', getAllplan );
router.delete("/:id", authMiddleware, requireAdmin('packages'), deletePlanById)
router.put("/:id", authMiddleware, requireAdmin('packages'), updatePlan);

module.exports = router;