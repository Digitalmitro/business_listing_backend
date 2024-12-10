
const Business = require('../models/Business');
const Question = require('../models/Questions');


exports.CreateQuestion = async (req, res) => {
    const { businessId, question } = req.body;
    const userId = req.user.id;
  if(!businessId || !question || !userId) return res.status(400).json({message:"missing required fields"})
    try {
      const business = await Business.findById(businessId);
      if (!business) {
        return res.status(404).json({ message: "Business not found" });
      }
      const newQuestion = new Question({
        questionText: question,
        business: business._id,
        askedBy: userId,
      });
  
      await newQuestion.save();
      return res.status(201).json({ message: "Question created successfully", question: newQuestion });
  
    } catch (error) {
        return res.status(500).json({ message: "Server error", details: error.message })
    }
  };

exports.getAllQuestion = async (req,res) =>{
try {
  const question = await Question.find({}).populate('askedBy','full_name email');
  return res.status(200).json(question)
} catch (error) {
  return res.status(500).json({ message: "Server error", details: error.message })
}
}


