// backend/routes/crmContactRoutes.js
const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middlewares/authMiddleware");
const {
  createContact,
  getContacts,
  getContactById,
  updateContact,
  deleteContact,
  convertContactToLead,
  bulkDeleteContacts,
} = require("../controllers/crmContactController");

router.post("/", authMiddleware, createContact);
router.get("/", authMiddleware, getContacts);
router.post("/bulk-delete", authMiddleware, bulkDeleteContacts);
router.get("/:id", authMiddleware, getContactById);
router.put("/:id", authMiddleware, updateContact);
router.delete("/:id", authMiddleware, deleteContact);
router.post("/:id/convert", authMiddleware, convertContactToLead);

module.exports = router;
