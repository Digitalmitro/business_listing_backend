const { default: mongoose, Schema } = require("mongoose");

const footerLinksSchema = new Schema({
  active: { type: Boolean, default: true },

  about: [
    {
      name: String,
      url: String,
      external: { type: Boolean, default: false },
    },
  ],

  discover: [
    {
      name: String,
      url: String,
      external: { type: Boolean, default: false },
    },
  ],

  business: [
    {
      name: String,
      url: String,
      external: { type: Boolean, default: false },
    },
  ],

  social: {
    facebook: String,
    twitter: String,
    instagram: String,
    linkedin: String,
    youtube: String,
  },

  languages: [String],

  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("FooterLinks", footerLinksSchema);
