const TopCountry = require("../models/TopCountry");
const fs = require("fs");
const path = require("path");

const deleteFile = (filename) => {
  if (!filename) return;
  const filePath = path.join(__dirname, "..", "public", "uploads", filename);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    console.log("DELETED:", filename);
  }
};

const saveCountry = async (req, res, isUpdate = false) => {
  try {
    console.log("=== ₹1000 CRORE SAVE ===");
    console.log("Files:", req.files ? Object.keys(req.files) : "NONE");

    const { name, funFacts, galleryFilenames } = req.body;
    if (!name?.trim()) return res.status(400).json({ message: "Name required" });

    const updateData = { name: name.trim() };

    // === FUN FACTS ===
    if (funFacts) {
      try {
        updateData.funFacts = JSON.parse(funFacts).filter(f => f?.trim());
      } catch (e) {}
    }

    // === ICON ===
    if (req.files?.icon?.[0]) updateData.imageUrl = req.files.icon[0].filename;

    let country;

    if (isUpdate) {
      const old = await TopCountry.findById(req.params.id);
      if (!old) return res.status(404).json({ message: "Not found" });

      // DELETE OLD ICON
      if (req.files?.icon?.[0] && old.imageUrl) deleteFile(old.imageUrl);

      // === MUST VISIT PLACES ===
      if (req.body.mustVisitPlaces_0_name || Object.keys(req.files || {}).some(k => k.startsWith("mustVisitPlacesImages_"))) {
        console.log("MUST VISIT BLOCK TRIGGERED");
        const items = [];
        let i = 0;

        while (req.body[`mustVisitPlaces_${i}_name`]) {
          const name = req.body[`mustVisitPlaces_${i}_name`];
          const oldImg = req.body[`mustVisitPlaces_${i}_old`];
          const fileKey = `mustVisitPlacesImages_${i}`;
          const newImg = req.files?.[fileKey]?.[0]?.filename;
          const finalImg = newImg || oldImg || "";
          const description = req.body[`mustVisitPlaces_${i}_description`] || "";

          if (name?.trim()) {
            items.push({ name: name.trim(), image: finalImg, description: description.trim() });
          }
          i++;
        }

        const finalFilenames = items.map(item => item.image).filter(Boolean);
        old.mustVisitPlaces?.forEach(p => {
          if (p.image && !finalFilenames.includes(p.image)) deleteFile(p.image);
        });

        updateData.mustVisitPlaces = items;
        console.log(`MUST VISIT SAVED: ${items.length} places`);
      }

      // === RESTAURANTS ===
      if (req.body.restaurants_0_name || Object.keys(req.files || {}).some(k => k.startsWith("restaurantsImages_"))) {
        console.log("RESTAURANTS BLOCK TRIGGERED");
        const items = [];
        let i = 0;

        while (req.body[`restaurants_${i}_name`]) {
          const name = req.body[`restaurants_${i}_name`];
          const oldImg = req.body[`restaurants_${i}_old`];
          const fileKey = `restaurantsImages_${i}`;
          const newImg = req.files?.[fileKey]?.[0]?.filename;
          const finalImg = newImg || oldImg || "";
          const description = req.body[`restaurants_${i}_description`] || "";

          if (name?.trim()) {
            items.push({ name: name.trim(), image: finalImg, description: description.trim() });
          }
          i++;
        }

        const finalFilenames = items.map(item => item.image).filter(Boolean);
        old.restaurants?.forEach(r => {
          if (r.image && !finalFilenames.includes(r.image)) deleteFile(r.image);
        });

        updateData.restaurants = items;
        console.log(`RESTAURANTS SAVED: ${items.length}`);
      }

      // === HOTELS ===
      if (req.body.hotels_0_name || Object.keys(req.files || {}).some(k => k.startsWith("hotelsImages_"))) {
        console.log("HOTELS BLOCK TRIGGERED");
        const items = [];
        let i = 0;

        while (req.body[`hotels_${i}_name`]) {
          const name = req.body[`hotels_${i}_name`];
          const oldImg = req.body[`hotels_${i}_old`];
          const fileKey = `hotelsImages_${i}`;
          const newImg = req.files?.[fileKey]?.[0]?.filename;
          const finalImg = newImg || oldImg || "";
          const description = req.body[`hotels_${i}_description`] || "";

          if (name?.trim()) {
            items.push({ name: name.trim(), image: finalImg, description: description.trim() });
          }
          i++;
        }

        const finalFilenames = items.map(item => item.image).filter(Boolean);
        old.hotels?.forEach(h => {
          if (h.image && !finalFilenames.includes(h.image)) deleteFile(h.image);
        });

        updateData.hotels = items;
        console.log(`HOTELS SAVED: ${items.length}`);
      }

      // === GALLERY ===
      if (galleryFilenames || req.files?.galleryImages) {
        let finalFilenames = [];
        if (galleryFilenames && galleryFilenames !== "[]") {
          try { finalFilenames = JSON.parse(galleryFilenames); } catch (e) {}
        }
        const newFiles = req.files?.galleryImages || [];
        newFiles.forEach(f => finalFilenames.push(f.filename));

        old.gallery?.forEach(g => {
          if (g.image && !finalFilenames.includes(g.image)) deleteFile(g.image);
        });

        updateData.gallery = finalFilenames.map(img => ({ image: img }));
        console.log(`GALLERY SAVED: ${finalFilenames.length} images`);
      }

      country = await TopCountry.findByIdAndUpdate(req.params.id, updateData, { new: true });
    } 
    else {
      // === CREATE MODE ===
      const mustVisit = [];
      let i = 0;
      while (req.body[`mustVisitPlaces_${i}_name`]) {
        const name = req.body[`mustVisitPlaces_${i}_name`];
        const img = req.files?.[`mustVisitPlacesImages_${i}`]?.[0]?.filename;
        const description = req.body[`mustVisitPlaces_${i}_description`] || "";
        if (name?.trim()) {
          mustVisit.push({ name: name.trim(), image: img || "", description: description.trim() });
        }
        i++;
      }

      const restaurants = [];
      i = 0;
      while (req.body[`restaurants_${i}_name`]) {
        const name = req.body[`restaurants_${i}_name`];
        const img = req.files?.[`restaurantsImages_${i}`]?.[0]?.filename;
        const description = req.body[`restaurants_${i}_description`] || "";
        if (name?.trim()) {
          restaurants.push({ name: name.trim(), image: img || "", description: description.trim() });
        }
        i++;
      }

      const hotels = [];
      i = 0;
      while (req.body[`hotels_${i}_name`]) {
        const name = req.body[`hotels_${i}_name`];
        const img = req.files?.[`hotelsImages_${i}`]?.[0]?.filename;
        const description = req.body[`hotels_${i}_description`] || "";
        if (name?.trim()) {
          hotels.push({ name: name.trim(), image: img || "", description: description.trim() });
        }
        i++;
      }

      updateData.mustVisitPlaces = mustVisit;
      updateData.restaurants = restaurants;
      updateData.hotels = hotels;
      updateData.gallery = (req.files?.galleryImages || []).map(f => ({ image: f.filename }));

      country = new TopCountry(updateData);
      await country.save();
    }

    return res.json({ message: "Success", data: country });
  } catch (error) {
    console.error("ERROR:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

// CREATE
exports.createTopcountry = (req, res) => saveCountry(req, res, false);

// UPDATE
exports.updateTopCountry = (req, res) => saveCountry(req, res, true);

// GET ALL
exports.getTopcountry = async (req, res) => {
  try {
    const { search = "", page = 1, limit = 10 } = req.query;
    const query = search ? { name: { $regex: search, $options: "i" } } : {};

    const countries = await TopCountry.find(query)
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await TopCountry.countDocuments(query);

    res.json({
      countries,
      totalPages: Math.ceil(total / limit),
      currentPage: +page,
      total,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};

// GET BY NAME (for frontend)
exports.getCountryByName = async (req, res) => {
  try {
    const { name } = req.params;
    const country = await TopCountry.findOne({
      name: { $regex: `^${name}$`, $options: "i" },
    });

    if (!country) return res.status(404).json({ message: "Country not found" });
    res.json(country);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};

// DELETE
exports.deleteTopCountry = async (req, res) => {
  try {
    const country = await TopCountry.findById(req.params.id);
    if (!country) return res.status(404).json({ message: "Country not found" });

    // Delete all images
    if (country.imageUrl) deleteFile(country.imageUrl);
    country.mustVisitPlaces.forEach((p) => p.image && deleteFile(p.image));
    country.restaurants.forEach((r) => r.image && deleteFile(r.image));
    country.hotels.forEach((h) => h.image && deleteFile(h.image));

    await TopCountry.findByIdAndDelete(req.params.id);
    res.json({ message: "Deleted successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};
