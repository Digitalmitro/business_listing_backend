const TopServices =require("../models/TopServices");

exports.getTopServices= async  (req,res) =>{
    try {
        const topServices = await TopServices.find();
        res.status(200).json(topServices);
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
      }
}

exports.createTopServices = async(req,res)=>{
    try {
        const { name } = req.body;
        if(!name || !req.file)  return res.status(400).json({ message: "Name and category are required" });
        const iconUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
      const newTopServices = new TopServices({
        name,
        imageUrl:iconUrl
      });
      await newTopServices.save();
  
      res.status(201).json({ message: 'TopCountry created successfully', data: newTopServices });
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: 'Server error' });
    }
}