const Vertical = require("../models/Vertical");

exports.insertManyVerticals = async (req, res) => {
    try {
        const verticalsData = [
            { title: "B2B", description: "Business-to-business (B2B) services provide products and solutions tailored for businesses." },
            { title: "All India", description: "A platform covering diverse business sectors across India." },
            { title: "Doctors", description: "Medical professionals providing healthcare services." },
            { title: "Bills & Recharge", description: "Online bill payments and mobile recharges made easy." },
            { title: "Accommodation", description: "Hotels, hostels, and rental accommodations for travelers and professionals." },
            { title: "Advertising & PR", description: "Marketing, branding, and public relations services." },
            { title: "Agriculture", description: "Farming, seeds, fertilizers, and agriculture technology solutions." },
            { title: "Apparel", description: "Clothing and fashion industry, including retail and wholesale." },
            { title: "Astrology", description: "Astrology services, horoscope readings, and numerology." },
            { title: "Automobiles & Two Wheelers", description: "Cars, bikes, and auto services for buyers and sellers." },
            { title: "Beauty & Personal Care", description: "Skincare, cosmetics, salons, and grooming services." },
            { title: "Business & Legal", description: "Consulting, legal advisory, and corporate services." },
            { title: "Chemicals", description: "Industrial and laboratory chemicals for various applications." },
            { title: "Construction & Real Estate", description: "Builders, developers, and property management services." },
            { title: "Education", description: "Schools, colleges, training institutes, and e-learning." },
            { title: "Electronic Component", description: "Manufacturing and distribution of electronic parts." },
            { title: "Electronics", description: "Consumer and industrial electronics, gadgets, and appliances." },
            { title: "Energy", description: "Renewable energy, electricity distribution, and power generation." },
            { title: "Engineering", description: "Mechanical, civil, electrical, and software engineering services." },
            { title: "Entertainment", description: "Media, music, movies, and gaming industry services." },
            { title: "Events & Wedding", description: "Event planning, wedding services, and corporate events." },
            { title: "Food & Beverage", description: "Restaurants, catering, packaged food, and beverages." },
            { title: "Furniture", description: "Home and office furniture, including custom designs." },
            { title: "Health & Medical", description: "Hospitals, pharmacies, diagnostics, and wellness centers." },
            { title: "Home & Garden", description: "Home decor, gardening, and interior designing services." },
            { title: "Housekeeping & Facility Management", description: "Cleaning, maintenance, and facility services." },
            { title: "Industrial Plants & Machinery", description: "Manufacturing equipment, heavy machinery, and industrial automation." },
            { title: "IT Components", description: "Hardware, software, and IT support services." },
            { title: "Jewellery", description: "Gold, silver, diamond, and artificial jewellery businesses." },
            { title: "Lights & Lighting", description: "LEDs, decorative lights, and industrial lighting solutions." },
            { title: "Luggage Bags & Cases", description: "Travel bags, suitcases, and storage cases." },
            { title: "Office & School Supplies", description: "Stationery, office furniture, and school equipment." },
            { title: "Packaging & Printing", description: "Custom packaging, printing services, and branding." },
            { title: "Pet & Pet Supplies", description: "Pet food, accessories, and veterinary services." },
            { title: "Placements", description: "Job placement, recruitment, and HR solutions." }
          ];
          
      const insertedVerticals = await Vertical.insertMany(verticalsData);
      res.status(201).json({
        message: "Verticals inserted successfully!",
        data: insertedVerticals
      });
    } catch (error) {
      res.status(500).json({ message: "Error inserting verticals", error });
    }
  };

// Create a new vertical
exports.createVertical = async (req, res) => {
  try {
    const { title, description } = req.body;

    // Check if vertical with the same title exists
    const existingVertical = await Vertical.findOne({ title });
    if (existingVertical) {
      return res.status(400).json({ message: "Vertical already exists" });
    }

    const vertical = new Vertical({ title, description });
    await vertical.save();
    res.status(201).json(vertical);
  } catch (error) {
    res.status(500).json({ message: "Server error", error });
  }
};

// Get all verticals
exports.getAllVerticals = async (req, res) => {
  try {
    const verticals = await Vertical.find();
    res.status(200).json(verticals);
  } catch (error) {
    res.status(500).json({ message: "Server error", error });
  }
};

// Get a vertical by title
exports.getVerticalByTitle = async (req, res) => {
  try {
    const { title } = req.params;
    const vertical = await Vertical.findOne({ title: { $regex: new RegExp(title, "i") } });
    if (!vertical) {
      return res.status(404).json({ message: "Vertical not found" });
    }

    res.status(200).json(vertical);
  } catch (error) {
    res.status(500).json({ message: "Server error", error });
  }
};

// Update a vertical by title
exports.updateVertical = async (req, res) => {
  try {
    const { title } = req.params;
    const updatedData = req.body;

    const updatedVertical = await Vertical.findOneAndUpdate(
      { title },
      updatedData,
      { new: true, runValidators: true }
    );

    if (!updatedVertical) {
      return res.status(404).json({ message: "Vertical not found" });
    }

    res.status(200).json(updatedVertical);
  } catch (error) {
    res.status(500).json({ message: "Server error", error });
  }
};

// Delete a vertical by title
exports.deleteVertical = async (req, res) => {
  try {
    const { title } = req.params;
    const deletedVertical = await Vertical.findOneAndDelete({ title });

    if (!deletedVertical) {
      return res.status(404).json({ message: "Vertical not found" });
    }

    res.status(200).json({ message: "Vertical deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Server error", error });
  }
};
