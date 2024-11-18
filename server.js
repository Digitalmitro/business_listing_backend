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

app.use('/api/auth', authRoutes);
app.use('/api/category', categoryRoutes);
app.use('/api/banner', bannerRoutes);
app.use('/api/top_banner', topBannerCategoryRoutes);
app.use('/api/subCategory', subCategoryRoutes)
app.use('/api/business',business)
const PORT = process.env.PORT || 5000
app.listen(PORT, (err)=>{
    if(err) throw err;
    console.log(`server is running on ${PORT}`)
})