// controllers/blogController.js
const Blog = require("../models/Blog");
const fs = require("fs");
const path = require("path");

// Helper: Generate unique slug
const generateUniqueSlug = async (title) => {
  let slug = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  let exists = await Blog.findOne({ slug });
  let counter = 1;
  while (exists) {
    const newSlug = `${slug}-${counter}`;
    exists = await Blog.findOne({ slug: newSlug });
    counter++;
    slug = newSlug;
  }
  return slug;
};

// ==================== ADMIN ONLY ====================

// Create Blog
exports.createBlog = async (req, res) => {
  try {
    const {
      title,
      content,
      excerpt,
      authorName,
      authorPhoto,
      authorBio,
      category,
      tags,
      metaTitle,
      metaDescription,
      focusKeyword,
      faq,
      relatedBlogs,
      isPublished,
    } = req.body;

    if (!title || !content || !excerpt || !req.file) {
      return res
        .status(400)
        .json({ message: "Title, content, excerpt & image are required" });
    }

    const slug = await generateUniqueSlug(title);

    const blog = new Blog({
      title,
      slug,
      featuredImage: `/${req.file.filename}`,
      content,
      excerpt,
      author: {
        name: authorName,
        photo: authorPhoto || "",
        bio: authorBio || "",
      },
      category,
      tags: tags ? tags.split(",").map((t) => t.trim()) : [],
      metaTitle: metaTitle || title,
      metaDescription: metaDescription || excerpt,
      focusKeyword,
      faq: faq ? JSON.parse(faq) : [],
      relatedBlogs: relatedBlogs || [],
      isPublished: isPublished === "true" || isPublished === true,
      publishedAt: isPublished === "true" ? new Date() : null,
    });

    await blog.save();
    await blog.populate("relatedBlogs", "title slug featuredImage");

    res.status(201).json({
      message: "Blog created successfully",
      blog,
    });
  } catch (err) {
    console.error("Create blog error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

// Update Blog
exports.updateBlog = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const blog = await Blog.findById(id);
    if (!blog) return res.status(404).json({ message: "Blog not found" });

    // Handle image update
    if (req.file) {
      // Delete old image
      if (blog.featuredImage) {
        const oldPath = path.join(
          __dirname,
          "..",
          "public",
          blog.featuredImage
        );
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }
      updates.featuredImage = `/${req.file.filename}`;
    }

    // Regenerate slug if title changed
    if (updates.title && updates.title !== blog.title) {
      updates.slug = await generateUniqueSlug(updates.title);
    }

    // Handle published status
    if (updates.isPublished === "true" && !blog.isPublished) {
      updates.publishedAt = new Date();
    }

    Object.assign(blog, updates);
    if (updates.tags) blog.tags = updates.tags.split(",").map((t) => t.trim());
    if (updates.faq) blog.faq = JSON.parse(updates.faq);

    await blog.save();
    await blog.populate("relatedBlogs", "title slug featuredImage");

    res.json({ message: "Blog updated", blog });
  } catch (err) {
    console.error("Update blog error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// Delete Blog
exports.deleteBlog = async (req, res) => {
  try {
    const { id } = req.params;
    const blog = await Blog.findById(id);
    if (!blog) return res.status(404).json({ message: "Blog not found" });

    // Delete image
    if (blog.featuredImage) {
      const filePath = path.join(__dirname, "..", "public", blog.featuredImage);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }

    await blog.deleteOne();
    res.json({ message: "Blog deleted successfully" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// ==================== PUBLIC ROUTES ====================

// Get All Published Blogs (List Page)
exports.getBlogs = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 12;
    const skip = (page - 1) * limit;

    const blogs = await Blog.find({ isPublished: true })
    //   .select(
    //     "title slug featuredImage excerpt author category tags publishedAt"
    //   )
      .sort({ publishedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await Blog.countDocuments({ isPublished: true });

    res.json({
      blogs,
      pagination: {
        current: page,
        totalPages: Math.ceil(total / limit),
        total,
      },
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// Get Single Blog by Slug
exports.getBlogBySlug = async (req, res) => {
  try {
    const { slug } = req.params;

    const blog = await Blog.findOne({ slug, isPublished: true })
      .populate("relatedBlogs", "title slug featuredImage excerpt")
      .lean();

    if (!blog) return res.status(404).json({ message: "Blog not found" });

    // Increase view count (optional)
    // await Blog.findByIdAndUpdate(blog._id, { $inc: { views: 1 } });

    res.json(blog);
  } catch (err) {
    console.error("Get blog error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// Admin: Get All Blogs (including drafts)
exports.getAdminBlogs = async (req, res) => {
  try {
    const blogs = await Blog.find()
      .select("title slug isPublished publishedAt createdAt")
      .sort({ createdAt: -1 })
      .lean();

    res.json({ blogs });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
