const express = require('express')
const cors = require('cors')
const dotenv=require('dotenv')
const connectDB = require('./config/db')
const authRoutes = require('./routes/authRoutes.js');
const categoryRoutes = require('./routes/categoryRoutes');
const bannerRoutes = require('./routes/bannerRoutes');
const topBannerCategoryRoutes = require('./routes/topBannerCategoryRoutes');
const subCategoryRoutes = require('./routes/subCategoryRoutes.js');
const business = require('./routes/businessRoutes.js')
const notificationRoutes = require('./routes/notificationRoutes.js');
const topCountryRoutes = require('./routes/topCountryRoutes.js');
const adminRoutes = require('./routes/adminRoutes.js');
const planRoutes  = require('./routes/planRoutes.js')
const reviewRoutes = require('./routes/reviewRoutes.js')
const appointmentRoutes = require('./routes/appointmentRoutes.js')
const enquiryRoutes = require('./routes/enquiryRoutes.js')
const questionRoutes = require('./routes/questionRoutes.js')
const topServiesRoutes=require("./routes/topServicesRoutes")
const freeListingRoutes=require("./routes/freeListingRoutes")
const verticalRoutes = require("./routes/verticalRoutes");
const claimRoutes = require("./routes/claimRoutes");
const emailCampaignRoutes = require("./routes/emailCampaignRoutes")
const fs = require('fs');
const path = require('path');

// Ensure 'public/uploads' directory exists
const uploadDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
dotenv.config()
connectDB()
const app = express();

app.use(express.json());
app.use(cors())
// Serve static files from the 'public' directory
app.use('/uploads', express.static('public/uploads'));
app.get('/',(req,res)=>{
  res.status(200).json({"message":'Wellcome Urbancitations Server! ✨'})
})
app.use('/api/auth', authRoutes);
app.use('/api/category', categoryRoutes);
app.use('/api/banner', bannerRoutes);
app.use('/api/top_banner', topBannerCategoryRoutes);
app.use('/api/subCategory', subCategoryRoutes);
app.use('/api/business',business);
app.use('/api/notification', notificationRoutes);
app.use('/api', topCountryRoutes);
app.use('/admin', adminRoutes);
app.use('/api/plan', planRoutes);
app.use('/api/review', reviewRoutes);
app.use('/api', appointmentRoutes);
app.use("/api", claimRoutes);
app.use("/api", emailCampaignRoutes);
app.use('/api', enquiryRoutes);
app.use('/api', questionRoutes);
app.use('/api', topServiesRoutes);
app.use('/api', freeListingRoutes);
app.use("/api/verticals", verticalRoutes);

const PORT = process.env.PORT || 5000
app.listen(PORT, (err)=>{
    if(err) throw err;
    console.log(`server is running on ${PORT}`)
})