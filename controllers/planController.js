const Plan = require("../models/Plan");

exports.getAllplan = async (req, res) => {
  try {
    const plans = await Plan.find();
    res.status(200).json(plans);
  } catch (error) {
    res
      .status(500)
      .json({ error: "Error fetching plans", details: error.message });
  }
};

exports.createPlan = async (req, res) => {
  try {
    const {
      name,
      description,
      discount,
      pricePerDay,
      searchVisibilityMultiplier,
      features,
    } = req.body;

    // Create new plan
    const newPlan = new Plan({
      name,
      description,
      discount,
      pricePerDay,
      searchVisibilityMultiplier,
      features,
    });

    // Save to DB
    const savedPlan = await newPlan.save();
    res.status(201).json(savedPlan);
  } catch (error) {
    if (error.name === "ValidationError") {
      res.status(400).json({ message: error.message });
    } else if (error.code === 11000) {
      res.status(409).json({ message: "Plan name must be unique" });
    } else {
      res.status(500).json({ message: "Server error" });
    }
  }
};

// DELETE api
exports.deletePlanById = async (req, res) => {
  try {
    const { id } = req.params;
    
    const deletedPlan = await Plan.findByIdAndDelete(id);

    if (!deletedPlan) {
      return res.status(404).json({ message: "Plan not found" });
    }

    res.status(200).json({ message: "Plan deleted successfully", deletedPlan });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// update api
exports.updatePlan = async (req, res) => {
  try {
    const { id } = req.params; 
    const updateData = req.body; 

   
    const updatedPlan = await Plan.findByIdAndUpdate(id, updateData, {
      new: true, 
      runValidators: true, 
    });

    if (!updatedPlan) {
      return res.status(404).json({ message: "Plan not found" });
    }

    res.status(200).json(updatedPlan);
  } catch (error) {
    if (error.name === "ValidationError") {
      res.status(400).json({ message: error.message });
    } else {
      res.status(500).json({ message: "Server error" });
    }
  }
};


