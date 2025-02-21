const FreeListing =require("../models/FreeListing");

exports.getFreeListing= async  (req,res) =>{
    try {
        const freeListing = await FreeListing.find();
        res.status(200).json(freeListing);
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
      }
}

exports.createFreeListing = async(req,res)=>{
    try {
        const { name } = req.body;
        if(!name || !req.file)  return res.status(400).json({ message: "Name and category are required" });
        const iconUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
      const newFreeListing = new FreeListing({
        name,
        imageUrl:iconUrl
      });
      await newFreeListing.save();
  
      res.status(201).json({ message: 'TopCountry created successfully', data: newFreeListing });
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: 'Server error' });
    }
}