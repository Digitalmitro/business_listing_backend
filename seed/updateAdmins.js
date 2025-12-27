const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const Admin = require('../models/Admin');
const connectDB = require('../config/db');

const updateAdminsToSuperAdmin = async () => {
  try {
    // 1. Connect to Database
    await connectDB();

    console.log('Fetching all admins...');
    const admins = await Admin.find({});

    if (admins.length === 0) {
      console.log('No admins found in the database.');
      process.exit(0);
    }

    console.log(`Updating ${admins.length} admins to super-admin...`);

    // 2. Update all admins
    const result = await Admin.updateMany(
      {}, 
      { 
        $set: { 
          role: 'super-admin',
          permissions: [
            "dashboard", "cms", "categories", "subcategories", "users", "business", 
            "email_marketing", "seo", "top_countries", "packages", "notifications", 
            "questions", "enquiries", "sub_admin"
          ]
        } 
      }
    );

    console.log(`Successfully updated ${result.modifiedCount} admins.`);
    console.log('All existing admins are now super-admins with full permissions.');

    process.exit(0);
  } catch (error) {
    console.error('Error updating admins:', error);
    process.exit(1);
  }
};

updateAdminsToSuperAdmin();
