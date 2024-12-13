const Review = require('../models/Review');
const Business = require('../models/Business');

exports.createReview = async (req, res) => {
    const { businessId, rating, comment } = req.body;
    const userId = req.user.id;
    if (!businessId || !rating || !userId) {
        return res.status(400).json({
            success: false,
            message: "Missing required fields"
        });
    }
    try {
        const review = new Review({ businessId, userId, rating, comment });
        await review.save();
        const aggregationResult = await Review.find({ businessId: businessId });

        if (aggregationResult.length > 0) {
            const count = aggregationResult.length;
            const avgRating = aggregationResult.reduce((sum, review) => sum + review.rating, 0) / count;
            await Business.updateOne(
                { _id: businessId },
                {
                    $set: {
                        totalReviews: count,
                        rating: avgRating
                    }
                }
            );
        }
      
        res.status(201).json({ message: 'Review added successfully!', review });
    } catch (err) {
        if (err.code === 11000) {
            res.status(400).json({ error: 'You have already reviewed this business.' });
        } else {
            res.status(500).json({ error: 'Failed to add review.' });
        }
    }
}

exports.getReviews = async (req, res) => {
    const { businessId } = req.params;

    try {
        const reviews = await Review.find({ businessId })
            .populate('userId', ' full_name ')
            .sort({ createdAt: -1 });

        res.status(200).json(reviews);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch reviews.' });
    }
}