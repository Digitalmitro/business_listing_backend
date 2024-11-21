const Plan = require('../models/Plan')

exports.getAllplan = async (req,res) =>{
    try {
        const plans = await Plan.find(); 
        res.status(200).json(plans);
      } catch (error) {
        res.status(500).json({ error: 'Error fetching plans', details: error.message });
      }
}
