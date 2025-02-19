const mongoose=require('mongoose')
const { Schema } = mongoose;
const topServicesSchema=new Schema({
    name: {
      type: String,
      required: true,
      unique: true
    },
    imageUrl: {
      type: String,
      required: true
    },
    createdAt: {
      type: Date,
      default: Date.now
    },
    updatedAt: {
      type: Date,
      default: Date.now
    }
  });

module.exports = mongoose.model('TopServices', topServicesSchema);
