const mongoose = require("mongoose");

const AppointmentSchema = new mongoose.Schema({
  userId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "User", 
    required: true 
  },
  businessId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "Business", 
    required: true 
  },
  appointmentDate: { 
    type: Date, 
    required: true 
  },
  timeSlot: { 
    type: String, 
    required: false
  }, 
  fee: { 
    type: Number, 
    required: false 
  },
  status: {
    type: String,
    enum: ["Scheduled", "Canceled", "Completed", "Rescheduled"],
    default: "Scheduled"
  },
  rescheduledFrom: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "Appointment" 
  },
  createdAt: { 
    type: Date, 
    default: Date.now 
  },
  updatedAt: { 
    type: Date, 
    default: Date.now 
  },
 
});
module.exports = mongoose.model("Appointment", AppointmentSchema);
