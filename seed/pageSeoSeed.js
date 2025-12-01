require("dotenv").config({ path: require('path').resolve(__dirname, '../.env') });
const mongoose = require("mongoose");
const PageSEO = require("../models/PageSeo");


const seedPageSEO = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB");

    const defaultPages = [
      {
        pageKey: "home",
        title: "UrbanCitations - Find Local Services Near You | Salons, Doctors, Plumbers",
        description: "Discover 50,000+ verified businesses in your city. Book appointments, read reviews, get best deals. India's fastest growing local directory.",
        keywords: ["local services", "near me", "salons", "doctors", "plumbers", "book appointment"],
        ogImage: "https://urbancitations.com/og-home.jpg",
      },
      {
        pageKey: "about",
        title: "About UrbanCitations - India's No.1 Local Business Directory",
        description: "We started in 2024 to connect customers with trusted local businesses. 4.8/5 rated platform.",
        ogImage: "https://urbancitations.com/og-about.jpg",
      },
      {
        pageKey: "privacy",
        title: "Privacy Policy - UrbanCitations",
        description: "We never sell your data. Your privacy is our priority.",
      },
      {
        pageKey: "terms",
        title: "Terms of Use - UrbanCitations",
        description: "By using UrbanCitations, you agree to our terms and conditions.",
      },
      {
        pageKey: "customer-care",
        title: "Customer Care - Contact Us | UrbanCitations",
        description: "Need help? Call +91 91629-034539 or email support@urbancitations.com",
      },
      {
        pageKey: "freelisting",
        title: "Free Business Listing - Add Your Business on UrbanCitations",
        description: "Get found by 1M+ customers monthly. List your business for FREE in 2 minutes!",
      },
      {
        pageKey: "advertise",
        title: "Advertise With Us - Reach 1 Million+ Customers | UrbanCitations",
        description: "Promote your business with banner ads, featured listings, and verified badges.",
      },
      {
        pageKey: "more-categories",
        title: "All Categories - Explore 500+ Services | UrbanCitations",
        description: "Find salons, spas, doctors, restaurants, gyms, and more in your city.",
      },
      {
        pageKey: "business-profile",
        title: "{businessName} - Best {category} in {area}, {city}",
        description: "Book appointment at {businessName}. {address}. Rated {rating}/5 from {reviews} reviews.",
        // Note: This is a template — frontend will replace {businessName}, etc.
      },
    ];

    // Upsert (insert if not exists, update if exists)
    for (let page of defaultPages) {
      await PageSEO.findOneAndUpdate(
        { pageKey: page.pageKey },
        page,
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      console.log(`Seeded: ${page.pageKey}`);
    }

    console.log("ALL PAGE SEO SEEDED SUCCESSFULLY!");
    process.exit(0);
  } catch (err) {
    console.error("Seed failed:", err);
    process.exit(1);
  }
};

seedPageSEO();