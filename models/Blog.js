const mongoose = require("mongoose");

const BlogSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, unique: true, required: true },
    featuredImage: { type: String, required: true },
    content: { type: String, required: true }, // Rich HTML from editor
    excerpt: { type: String, required: true, maxlength: 300 },

    author: {
      name: { type: String, required: true },
      photo: { type: String },
      bio: { type: String, maxlength: 200 },
    },

    category: { type: String, required: true },
    tags: [{ type: String }],

    // SEO Fields
    metaTitle: { type: String, maxlength: 60 },
    metaDescription: { type: String, maxlength: 155 },
    focusKeyword: { type: String },

    isPublished: { type: Boolean, default: false },
    publishedAt: { type: Date },

    relatedBlogs: [{ type: mongoose.Schema.Types.ObjectId, ref: "Blog" }],
    faq: [
      {
        question: String,
        answer: String,
      },
    ],
  },
  { timestamps: true }
);

// Auto slug + published date
BlogSchema.pre("save", function (next) {
  if (this.isModified("title") || !this.slug) {
    this.slug = this.title
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }
  if (this.isPublished && !this.publishedAt) {
    this.publishedAt = new Date();
  }
  next();
});

module.exports = mongoose.model("Blog", BlogSchema);
