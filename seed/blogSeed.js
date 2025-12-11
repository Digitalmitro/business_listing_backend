// scripts/blogSeeder.js — FINAL FIXED VERSION
const mongoose = require("mongoose");
require("dotenv").config({
  path: require("path").resolve(__dirname, "../.env"),
});

const Blog = require("../models/Blog");

mongoose
  .connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/urbancitations")
  .then(() => console.log("MongoDB Connected"))
  .catch((err) => {
    console.error("Connection failed:", err);
    process.exit(1);
  });

// Placeholder images
const placeholderImages = [
  "https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=800",
  "https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?w=800",
  "https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=800",
  "https://images.unsplash.com/photo-1519389950470-47ba2b3d8b8c?w=800",
  "https://images.unsplash.com/photo-1504754524776-991c3f1478da?w=800",
  "https://picsum.photos/800/600?random=1",
  "https://picsum.photos/800/600?random=2",
  "https://picsum.photos/800/600?random=3",
];

const blogs = [
  {
    title: "How to Choose the Best Packers and Movers in 2025",
    excerpt:
      "Moving to a new home? Here's your complete guide to selecting reliable packers and movers with zero stress.",
    category: "Packers & Movers",
    tags: ["moving tips", "packers and movers", "home relocation"],
    metaTitle: "Best Packers and Movers in India 2025 - Complete Guide",
    metaDescription:
      "Find trusted packers and movers near you. Compare prices, read reviews, and book verified relocation services.",
    focusKeyword: "best packers and movers",
  },
  {
    title: "Top 10 AC Repair Mistakes You're Probably Making",
    excerpt:
      "Avoid costly repairs by learning the most common AC maintenance mistakes homeowners make.",
    category: "AC Repair",
    tags: ["ac service", "air conditioning", "summer tips"],
    metaTitle: "10 Common AC Repair Mistakes to Avoid in 2025",
    metaDescription:
      "Don't make these expensive AC repair mistakes! Learn what not to do when your air conditioner stops working.",
    focusKeyword: "ac repair mistakes",
  },
  {
    title: "Why Your Business Needs Local SEO in 2025",
    excerpt:
      "Local SEO is no longer optional. Discover why every local business must dominate Google Maps and local search.",
    category: "Digital Marketing",
    tags: ["local seo", "google my business", "local ranking"],
    metaTitle: "Local SEO Guide 2025: Rank #1 in Your City",
    metaDescription:
      "Complete local SEO strategy for small businesses. Rank higher on Google Maps and attract more local customers.",
    focusKeyword: "local seo 2025",
  },
  {
    title: "Salon at Home vs Salon Visit: Which is Better?",
    excerpt:
      "Compare cost, quality, and convenience of home salon services vs traditional salon visits.",
    category: "Beauty & Salon",
    tags: ["salon at home", "beauty services", "home grooming"],
    metaTitle: "Salon at Home vs Salon Visit: Complete Comparison 2025",
    metaDescription:
      "Should you book a salon at home or visit a parlor? We compare price, quality, and convenience.",
    focusKeyword: "salon at home vs salon",
  },
  {
    title: "How to Find Trusted Electricians Near You",
    excerpt:
      "Don't risk your home's safety. Learn how to identify genuine, licensed electricians in your area.",
    category: "Electrician",
    tags: ["electrician near me", "home wiring", "electrical safety"],
    metaTitle: "How to Find Trusted Electricians in Your City - 2025 Guide",
    metaDescription:
      "Verified tips to find licensed and reliable electricians. Avoid scams and get quality electrical work.",
    focusKeyword: "trusted electrician",
  },
];

const seedBlogs = async () => {
  try {
    console.log("Starting blog seeding...");

    let created = 0;
    for (let i = 0; i < blogs.length; i++) {
      const b = blogs[i];

      // Check if already exists
      const exists = await Blog.findOne({ title: b.title });
      if (exists) {
        console.log(`Skipping: ${b.title}`);
        continue;
      }

      // Generate slug manually (pre-save hook bypass ho raha tha)
      const slug = b.title
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");

      const blog = new Blog({
        ...b,
        slug, // ← YE ZAROORI THA!
        featuredImage: placeholderImages[i % placeholderImages.length],
        content: `<h2>Introduction</h2><p>${b.excerpt}</p>
                  <h2>Why This Matters</h2>
                  <p>This is a professionally written blog post generated for demo purposes. Replace with real content when ready.</p>
                  <ul>
                    <li>High-quality service providers</li>
                    <li>Verified reviews and ratings</li>
                    <li>Best price guarantee</li>
                    <li>24/7 customer support</li>
                  </ul>
                  <h2>Conclusion</h2>
                  <p>Choose Urban Citations for all your local service needs!</p>`,
        author: {
          name: "Urban Citations Team",
          photo:
            "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150",
          bio: "Helping local businesses grow since 2024",
        },
        isPublished: true,
        publishedAt: new Date(),
      });

      await blog.save();
      created++;
      console.log(`Created: ${blog.title} → /news/${blog.slug}`);
    }

    console.log(`BLOG SEEDING COMPLETE! ${created} blogs added.`);
    process.exit(0);
  } catch (err) {
    console.error("Seeding failed:", err.message);
    process.exit(1);
  }
};

seedBlogs();
