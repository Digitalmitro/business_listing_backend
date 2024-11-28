
const TopCountry = require('../models/TopCountry');

exports.createTopcountry = async(req,res)=>{
    try {
        const { name } = req.body;
        if(!name || !req.file)  return res.status(400).json({ message: "Name and category are required" });
        const iconUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
      const newTopCountry = new TopCountry({
        name,
        imageUrl:iconUrl
      });
      await newTopCountry.save();
  
      res.status(201).json({ message: 'TopCountry created successfully', data: newTopCountry });
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: 'Server error' });
    }
}

exports.getTopcountry = async  (req,res) =>{
    try {
        const topCountries = await TopCountry.find();
        res.status(200).json(topCountries);
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
      }
}