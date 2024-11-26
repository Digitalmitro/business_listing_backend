const Business = require('../models/Business')
const User = require('../models/User')
exports.createBusiness = async (req, res) => {
  try {
    const loggedInUserId = req.user.id;
    const businessData = req.body.businessData;
    const { useid } = businessData;
    const isAdmin = req.user?.role === 'admin';
    const userId = isAdmin && useid ? useid : loggedInUserId;
    //  console.log(businessData)
    if (!businessData) {
      return res.status(400).json({ message: 'Add all mandatory fields.' });
    }
    const newBusiness = new Business(businessData);
    const savedBusiness = await newBusiness.save();
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    user.businesses.push(savedBusiness._id);
    user.isSeller = true;
    await user.save();

    res.status(201).json({ success: true, business: savedBusiness });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.getBusiness = async (req, res) => {
  try {
    const { page = 1, limit = 10, search = '' } = req.query;

    const skip = (page - 1) * limit;
    const query = search
      ? {
          $or: [
            { "contact.email": { $regex: search, $options: 'i' } },
            { "contact.mobile": { $regex: search, $options: 'i' } }
          ]
        }
      : {};

    const businesses = await Business.find(query)
      .skip(skip)
      .limit(Number(limit));

    const total = await Business.countDocuments(query); 

    res.status(200).json({
      businesses,
      total,
      page: Number(page),
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

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

exports.blockBusiness = async (req, res) => {
  try {
    const { businessId } = req.params;
    const {isBlocked} = req.body;
    if(!businessId) return res.status(401).json({message: 'missig businessid'})
    const business = await Business.findById(businessId);
    if (!business) {
      return res.status(404).json({ message: 'Business not found' });
    }
    const updateData = {
      isBlocked: isBlocked, 
    };
    const result = await Business.updateOne(
      { _id: businessId }, 
      { $set: updateData }, 
    );
    if (result.modifiedCount === 0) {
      return res.status(400).json({ message: 'No changes were made, or business already blocked' });
    }
    res.status(200).json({ message: 'Business successfully blocked', business });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

exports.deleteBusiness = async (req, res) => {
  try {
    const { businessId } = req.params;
    const business = await Business.findByIdAndDelete(businessId);
    if (!business) {
      return res.status(404).json({ message: 'Business not found' });
    }
    const user = await User.findOne({ "businesses": businessId }); 
    if (user) {
      user.businesses.pull(businessId);
      user.isSeller = false;
      await user.save();
    }
    res.status(200).json({ message: 'Business successfully deleted' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Internal server error' });
  }
};


