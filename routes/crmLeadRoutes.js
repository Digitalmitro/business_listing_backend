// backend/routes/crmLeadRoutes.js
const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middlewares/authMiddleware");
const {
  createLead,
  getLeads,
  getLeadById,
  updateLead,
  addActivity,
  deleteLead,
  reorderKanban,
} = require("../controllers/crmLeadController");

router.post("/", authMiddleware, createLead);
router.get("/", authMiddleware, getLeads);
router.put("/kanban/reorder", authMiddleware, reorderKanban);
router.get("/:id", authMiddleware, getLeadById);
router.put("/:id", authMiddleware, updateLead);
router.post("/:id/activities", authMiddleware, addActivity);
router.delete("/:id", authMiddleware, deleteLead);

module.exports = router;
