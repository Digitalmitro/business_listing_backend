const Business = require('../models/Business')

 exports.createBusiness = async (req, res) => {
    try {
      const bdata = req.body.businessData
    
       if(!bdata) return res.status(400).json({"message":"add all manditry fileds"});
      //  console.log(bdata)
       const newBusiness = new Business(bdata);
      const business = await newBusiness.save();
      res.status(201).json({ success: true, business });
    } catch (error) {
      res.status(400).json({ success: false, message: error.message });
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

  exports.searchServices = async (req, res) => {
    try {
      const { query, location } = req.query;
  
      if (!query || !location) {
        return res.status(400).json({ message: "Location (address) is required" });
      }
  
      const services = await Business.aggregate([
        {
          $lookup: {
            from: 'categories',
            localField: 'category', 
            foreignField: '_id', 
            as: 'categoryDetails'
          }
        },
        {
          $lookup: {
            from: 'subcategories',
            localField: 'subCategory', 
            foreignField: '_id', 
            as: 'subCategoryDetails' 
          }
        },

        {
          $match: {
            address: { $regex: location, $options: 'i' }, // Fixed address search
            $or: [
              { name: { $regex: query, $options: 'i' } }, // Match by business name
              { 'categoryDetails.name': { $regex: query, $options: 'i' } }, // Match by category name
              { 'subCategoryDetails.name': { $regex: query, $options: 'i' } }, // Match by subcategory name
              { servicesTypes: { $elemMatch: { $regex: query, $options: 'i' } } } // Match by servicesTypes array
            ]
          }
        },
  
        {
          $unwind: {
            path: '$categoryDetails',
            preserveNullAndEmptyArrays: true 
          }
        },
        {
          $unwind: {
            path: '$subCategoryDetails',
            preserveNullAndEmptyArrays: true 
          }
        },
  
        {
          $project: {
            name: 1,
            address: 1,
            servicesTypes: 1,
            category: '$categoryDetails.name', 
            subCategory: '$subCategoryDetails.name', 
            image: 1,
            rating: 1,
            createdAt: 1,
            updatedAt: 1
          }
        }
      ]);

      if (services.length === 0) {
        return res.status(404).json({ message: "No services found matching your criteria" });
      }

      return res.status(200).json({
        message: "Services found",
        services
      });
  
    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Error searching for services', error: error.message });
    }
  };
  
  