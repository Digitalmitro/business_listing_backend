"use strict";

/**
 * Plan definitions (Basic / Silver / Gold / Premium), modelled on the tiers the
 * business asked for. Prices are USD per month; INR and GBP are 0 until the team
 * sets them in Admin → Packages (the pricing page then shows USD).
 *
 * Each feature row is [label, Basic, Silver, Gold, Premium]; "yes"/"no" render as
 * a tick/cross, anything else is shown as-is. Email entitlements come from
 * services/planEntitlements.js so the pricing page and the email rules can never
 * disagree.
 */

const { DEFAULT_ENTITLEMENTS } = require("../services/planEntitlements");

const Y = "yes";
const N = "no";

const GROUPS = [
  ["Core limits", [
    ["No. of keywords", "30", "40", "50", "100"],
    ["Backlinks per month", "40", "60", "100", "200"],
    ["Target pages optimized", "Up to 10", "Up to 15", "Up to 25", "Up to 40"],
    ["Google Business Profile (GBP)", N, Y, Y, Y],
    ["Geotagging", N, N, Y, Y],
    ["G.E.O (Generative Engine Optimization)", N, N, N, Y],
    ["A.E.O (Answer Engine Optimization)", N, N, N, Y],
    ["AI compatibility testing", Y, Y, Y, Y],
    ["AI visibility audit", "2 pages", "4 pages", "6 pages", "8 pages"],
  ]],
  ["First-hand SEO analysis", [
    ["Pre-optimization website analysis", N, N, Y, Y],
    ["Competitor analysis", N, N, Y, Y],
    ["Keyword research & analysis", Y, Y, Y, Y],
    ["Baseline ranking check", Y, Y, Y, Y],
    ["Duplicate content check", Y, Y, Y, Y],
    ["Google penalty check", Y, Y, Y, Y],
    ["Backlink analysis (if required)", N, N, Y, Y],
  ]],
  ["AI visibility", [
    ["AI semantic entity optimization", "Basic", "Enhanced", "NLP-rich", "Advanced NLP"],
    ["AI prompt injection testing", N, N, Y, Y],
    ["Schema validator & repair", Y, Y, Y, Y],
    ["Featured snippet testing (A/B)", N, N, Y, Y],
    ["AI index monitoring", "Monthly", "Monthly", "Monthly", "Monthly"],
    ["AI-attributed image & infographic optimization", N, N, "2 / mo", "4 / mo"],
    ["Website structure & AI parsability", "Basic", "Enhanced", "Advanced", "Advanced"],
    ["Internal linking optimization (AI)", "Basic", "Basic", "Enhanced", "Advanced"],
    ["Conversational AI optimization", N, N, Y, Y],
    ["Voice search optimization", N, N, N, Y],
    ["Zero-click optimization", N, N, N, Y],
    ["AI prompt-based landing pages", N, "1", "2", "3"],
    ["AI-optimized blog posts", "1 / mo", "1 / mo", "2 / mo", "2 / mo"],
    ["AI-optimized prompt FAQs", Y, Y, Y, Y],
    ["In-depth competitor AI analysis", N, N, Y, Y],
    ["AI ranking & visibility report", "Monthly", "Monthly", "Monthly", "Monthly"],
  ]],
  ["On-page optimization", [
    ["Canonical, title, meta, heading & image alt tags", Y, Y, Y, Y],
    ["Content optimization", Y, Y, Y, Y],
    ["SEO-friendly URL setup", Y, Y, Y, Y],
    ["Site navigation analysis", Y, Y, Y, Y],
    ["404 page implementation", Y, Y, Y, Y],
    ["Broken links & website speed check", Y, Y, Y, Y],
    ["Google indexed pages check", Y, Y, Y, Y],
    ["Robots.txt, XML & HTML sitemap", Y, Y, Y, Y],
    ["Hyperlink optimization", N, N, Y, Y],
    ["Website responsive check", Y, Y, Y, Y],
    ["Website permalinks analysis", N, N, Y, Y],
    ["Internal linking optimization", N, N, Y, Y],
    ["Google Webmaster Tools & Analytics setup", Y, Y, Y, Y],
    ["Bing Webmaster Tools setup", N, N, Y, Y],
    ["Structured data setup", N, N, Y, Y],
    ["On-site blog section creation", Y, Y, Y, Y],
    ["On-site blog posting (from 1st month)", "1", "2", "4", "5"],
  ]],
  ["Off-page optimization", [
    ["Search engine submission", Y, Y, Y, Y],
    ["Blog writing", "1", "1", "1", "3"],
    ["Blog links", "2", "2", "3", "5"],
    ["Blog social bookmarking links", "6", "10", "16", "35"],
    ["Article writing", "1", "2", "3", "4"],
    ["Article submissions", "1", "2", "3", "4"],
    ["Article marketing", "5", "10", "15", "25"],
    ["Image sharing", "2", "4", "8", "12"],
    ["Contextual links & keyword anchor text", Y, Y, Y, Y],
    ["Share each blog post on social networks", Y, Y, Y, Y],
    ["Web 2.0 profile creation", N, "1", "2", "5"],
    ["Web 2.0 profile bookmarking links", N, "4", "10", "25"],
    ["Press release & bookmarking (if you provide news)", N, N, N, Y],
    ["Social bookmarking links", "15", "24", "30", "60"],
    ["Micro blogging", "4", "7", "12", "20"],
    ["Classified submissions", "5", "8", "12", "25"],
    ["Infographics creation, posting & sharing", N, N, Y, Y],
    ["Google Business page creation", N, Y, Y, Y],
    ["Bing local listing creation", Y, Y, Y, Y],
    ["PPT submissions", N, N, "1", "3"],
    ["Video marketing (if you provide videos)", Y, Y, Y, Y],
    ["Location optimization", "1", "2", "4", "10"],
    ["Local business listings", "1", "2", "4", "10"],
    ["NAP syndication", Y, Y, Y, Y],
  ]],
  ["Social media (SMO)", [
    ["Facebook profile & fan page creation", N, Y, Y, Y],
    ["Facebook posting & sharing", N, "4", "8", "16"],
    ["Instagram profile creation", N, Y, Y, Y],
    ["Instagram posting & sharing", N, Y, "8", "16"],
    ["Twitter profile creation", N, Y, Y, Y],
    ["Twitter posts", N, "4", "8", "16"],
    ["Pinterest account & pin boards", N, N, "8", "16"],
    ["LinkedIn profile creation", N, N, N, Y],
    ["LinkedIn posting & sharing", N, N, N, "16"],
  ]],
  ["Reports", [
    ["Monthly website analytics report", Y, Y, Y, Y],
    ["Monthly keywords ranking report", Y, Y, Y, Y],
    ["Monthly off-page submission report", Y, Y, Y, Y],
  ]],
  ["Customer support", [
    ["Email, phone & chat support", Y, Y, Y, Y],
  ]],
];

const PLANS = [
  { name: "Basic", priceUSD: 500, sortOrder: 1 },
  { name: "Silver", priceUSD: 700, sortOrder: 2 },
  { name: "Gold", priceUSD: 1000, sortOrder: 3 },
  { name: "Premium", priceUSD: 1800, sortOrder: 4 },
];

function buildPackages() {
  return PLANS.map((plan, index) => ({
    name: plan.name,
    priceUSD: plan.priceUSD,
    priceINR: 0,
    priceGBP: 0,
    billingPeriod: "month",
    sortOrder: plan.sortOrder,
    isActive: true,
    featureGroups: GROUPS.map(([title, rows]) => ({
      title,
      items: rows.map((row) => ({ label: row[0], value: row[index + 1] })),
    })),
    entitlements: { ...DEFAULT_ENTITLEMENTS[plan.name], bookingReminders: [...DEFAULT_ENTITLEMENTS[plan.name].bookingReminders] },
  }));
}

module.exports = { GROUPS, PLANS, buildPackages };
