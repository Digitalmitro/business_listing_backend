// backend/models/CrmEvent.js
const mongoose = require("mongoose");

const CrmEventSchema = new mongoose.Schema(
  {
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Owner ID is required"],
      index: true,
    },
    leadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CrmLead",
      required: false,
      index: true,
    },
    title: {
      type: String,
      required: [true, "Event title is required"],
      trim: true,
      maxlength: [150, "Event title cannot exceed 150 characters"],
    },
    eventType: {
      type: String,
      trim: true,
      default: "Follow-Up",
      required: true,
    },
    startTime: {
      type: Date,
      required: [true, "Start time is required"],
      index: true,
    },
    endTime: {
      type: Date,
      required: false,
    },
    description: {
      type: String,
      trim: true,
      maxlength: [1000, "Description cannot exceed 1000 characters"],
      default: "",
    },
    locationOrLink: {
      type: String,
      trim: true,
      maxlength: [300, "Location or link cannot exceed 300 characters"],
      default: "",
    },
    status: {
      type: String,
      enum: ["Scheduled", "Completed", "Canceled"],
      default: "Scheduled",
    },
    isAllDay: {
      type: Boolean,
      default: false,
    },
    recurrence: {
      type: {
        type: String,
        enum: ["none", "daily", "weekly", "monthly", "yearly"],
        default: "none",
      },
      interval: {
        type: Number,
        default: 1,
      },
      endDate: {
        type: Date,
        default: null,
      },
    },
  },
  {
    timestamps: true,
  }
);

CrmEventSchema.index({ ownerId: 1, startTime: 1, endTime: 1 });

module.exports = mongoose.model("CrmEvent", CrmEventSchema);
