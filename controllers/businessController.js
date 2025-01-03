const Business = require('../models/Business')
const User = require('../models/User')
///this api use combine for admin and users
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
///this api use combnie for admin and users
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
          "addressString": { $regex: location, $options: 'i' },
          $or: [
            { businessName: { $regex: query, $options: 'i' } },
            { 'categoryDetails.name': { $regex: query, $options: 'i' } },
            { 'subCategoryDetails.name': { $regex: query, $options: 'i' } },
            { servicesTypes: { $elemMatch: { $regex: query, $options: 'i' } } }
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
          _id: 1,
          businessName: 1,
          description: 1,
          isBlocked: 1,
          address: 1,
          contact: 1,
          businessTiming: 1,
          category: '$categoryDetails.name',
          subCategory: '$subCategoryDetails.name',
          photos: 1,
          rating: 1,
          totalReviews: 1,
          verified: 1,
          trust: 1,
          claimed: 1,
          enquiryCount: 1,
          openUntil: 1,
          yearsOfEstablishment: 1,
          servicesTypes: 1,
          hygiene: 1,
          businessSummary: 1,
          createdAt: 1,
          updatedAt: 1,
        }
      }
    ]);

    if (services.length === 0) {
      return res.status(404).json({ message: "No services found matching your criteria" });
    }

    return res.status(200).json({
      message: "Services found",
      businesses: services
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Error searching for services', error: error.message });
  }
};

exports.blockBusiness = async (req, res) => {
  try {
    const { businessId } = req.params;
    const { isBlocked } = req.body;
    if (!businessId) return res.status(401).json({ message: 'missig businessid' })
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

exports.updateBusiness = async (req, res) => {
  const businessId = req.body.id;
  const updates = req.body.updateData;
  if (!businessId || !updates || Object.keys(updates).length === 0) {
    return res.status(400).json({ message: 'Invalid request: businessId and updates are required' });
  }
  try {
    const business = await Business.findById(businessId);
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    const allowedFields = [
      'businessName',
      'description',
      'isBlocked',
      'address',
      'contact',
      'businessTiming',
      'category',
      'subCategory',
      'photos',
      'rating',
      'totalReviews',
      'verified',
      'trust',
      'claimed',
      'enquiryCount',
      'openUntil',
      'yearsOfEstablishment',
      'servicesTypes',
      'hygiene',
      'businessSummary',
    ];
    const sanitizedUpdates = {};
    Object.keys(updates).forEach((key) => {
      if (allowedFields.includes(key)) {
        sanitizedUpdates[key] = updates[key];
      }
    });
    if (sanitizedUpdates.address) {
      const {
        blockName = business.address.blockName,
        streetName = business.address.streetName,
        area = business.address.area,
        landmark = business.address.landmark,
        pincode = business.address.pincode,
        city = business.address.city,
        state = business.address.state,
      } = sanitizedUpdates.address;

      sanitizedUpdates.address = {
        blockName,
        streetName,
        area,
        landmark,
        pincode,
        city,
        state,
      };
    }
    sanitizedUpdates.updatedAt = new Date();
    const updatedBusiness = await await Business.updateOne({ _id: businessId }, sanitizedUpdates);
    res.status(200).json({
      message: 'Business updated successfully',
      business: updatedBusiness,
    });
  } catch (error) {
    console.error('Error updating business:', error);
    res.status(500).json({ error: 'An error occurred while updating the business' });
  }
}

exports.getuserBusiness = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId).populate('businesses').exec();

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    return res.status(200).json({
      full_name: user.full_name,
      email: user.email,
      userImage: user.userImage,
      isSeller: user.isSeller,
      businesses: user.businesses
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

exports.getAllBusiness = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      category,
      isOpenNow,
      isTopRated,
      isQuickResponse,
      isVerified,
      hasDeals,
      isTrusted,
      sortBy,
      type
    } = req.query;
    const skip = (Number(page) - 1) * Number(limit);
    const query = {
      $and: [
        { isBlocked: false },
        ...(category ? [{ category }] : []),
        ...(isVerified ? [{ verified: isVerified === 'true' }] : []),
        ...(isTrusted ? [{ trust: isTrusted === 'true' }] : []),
        ...(type ? [{ type: { $in: type.split(",") } }] : []),
      ],
    };

    let sortCondition = {};
    if (sortBy) {
      if (sortBy === "A-Z") {
        sortCondition = { businessName: 1 };
      } else if (sortBy === "Z-A") {
        sortCondition = { businessName: -1 };
      } else if (sortBy === "Newest") {
        sortCondition = { createdAt: -1 };
      } else if (sortBy === "Oldest") {
        sortCondition = { createdAt: 1 };
      }
    }

    const businesses = await Business.find(query)
      .populate('category')
      .sort(sortCondition)
      .skip(skip)
      .limit(Number(limit));
    const total = await Business.countDocuments(query);
    res.status(200).json({
      success: true,
      page: Number(page),
      limit: Number(limit),
      total,
      businesses,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "internal server error",
      error: error.message,
    });
  }
};
