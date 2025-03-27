
const Business = require('../models/Business');
const Question = require('../models/Questions');
const sendMail = require('../services/sendMail')

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

exports.replyAnswer = async (req,res) =>{
  try {
    const { reply } = req.body;

    // Validate status
    if (!["answered", "rejected"].includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    if (!reply || reply.trim() === "") {
      return res.status(400).json({ message: "Reply message is required" });
    }

    const question = await Question.findById(req.params.id).populate("askedBy");

    if (!question) {
      return res.status(404).json({ message: "Question not found" });
    }

    // Update question with status & reply
    question.status = 'answered';
    question.reply = reply;
    question.updatedAt = Date.now();
    await question.save();

    // Send email to the user with the admin's response
    const user = question.askedBy;
    if (user?.email) {
      await sendMail(
        user.email,
        "Your Question Has Been Answered",
        `
        Dear ${user.name || "User"},
        
        Your question has been **${question?.status}** by the admin.
        
        **Question:** ${question.questionText}  
        **Admin Reply:** ${reply}  
        
        Thank you for reaching out to us!
        
        Regards,  
        Your Team
        `
      );
    }

    res.json({ message: "Reply sent and question status updated successfully" });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
}


