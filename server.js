const express = require('express')
const cors = require('cors')
const dotenv=require('dotenv')
const connectDB = require('./config/db')
const authRoutes = require('./routes/authRoutes.js');
dotenv.config()
connectDB()
const app = express();

app.use(express.json());
app.use(cors())

app.use('/api/auth', authRoutes);

const PORT = process.env.PORT || 5000
app.listen(PORT, (err)=>{
    if(err) throw err;
    console.log(`server is running on ${PORT}`)
})