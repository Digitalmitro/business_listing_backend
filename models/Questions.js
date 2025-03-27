const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const questionSchema = new Schema({
    questionText: {
        type: String,
        required: true,
        trim: true,
    },
    business: {
        type: Schema.Types.ObjectId,
        ref: 'Business',
        required: true,
    },
    askedBy: {
        type: Schema.Types.ObjectId,
        ref: 'User',
    },
    status: {
        type: String,
        enum: ["pending", "answered", "rejected"],
        default: "pending",
    },
    reply: {
        type: String, // Admin's response message
        trim: true,
        default: "",
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
    updatedAt: {
        type: Date,
        default: Date.now,
    },
});

module.exports = mongoose.model('Question', questionSchema);
