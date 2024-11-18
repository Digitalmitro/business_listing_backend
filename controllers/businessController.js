const Business = require('../models/Business')

exports.createBusiness = async (req, res) => {
    try {
      const { 
        name, description, address, phone, whatsapp, email, 
        category, subCategory,   openUntil, 
        yearsOfEstablishment, timings, businessSummary 
      } = req.body;
  
      if (!name || !category || !req.file) {
        return res.status(400).json({ message: "Required fields: name, category, image" });
      }
      const imageUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
      const business = new Business({
        name,
        description,
        address,
        phone,
        whatsapp,
        email,
        category,
        subCategory,
        image: imageUrl,
        openUntil,
        yearsOfEstablishment,
        timings,
        businessSummary
      });
  
      await business.save();
      res.status(201).json({ message: "Business created successfully", business });
    } catch (error) {
      res.status(500).json({ message: "Error creating business", error: error.message });
    }
  };

  exports.getBusiness= async (req,res) =>{
  try {
    const business = await Business.find()
    res.status(200).json({
        message: "Business fetched successfully",
        business,
      });

  } catch (error) {
    res.status(500).json({ message: "Error fetching business", error: error.message })
  }

  }