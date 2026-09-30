"use strict";

/**
 * Bulk contact import (CSV / Excel) for a business, in two steps:
 *
 *   1. analyze: parse the upload, suggest a column mapping (rules, then AI on header
 *      names only), and dry-run validation: valid rows, invalid emails, duplicates in
 *      the file, and how many match existing contacts.
 *   2. commit: with the confirmed mapping and options, create new contacts and update
 *      existing ones without losing their activity, engagement or opt-out status.
 *
 * After the commit, imported contacts are reviewed for engagement (triage): grouped
 * into anonymous segments (recency, customer, lead state, tags) and either entered
 * into a suitable switched-on journey or left waiting for activity. The AI makes that
 * call when available; clear rules do otherwise. Imported contacts are only ever
 * emailed when the owner confirmed they have permission to email them.
 *
 * Uploaded files live in a private directory (never under /public) and are deleted
 * after the commit or after 24 hours.
 */

const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");
const validator = require("validator");
const CrmContact = require("../models/CrmContact");
const CrmContactActivity = require("../models/CrmContactActivity");
const CrmContactImport = require("../models/CrmContactImport");
const CrmJourney = require("../models/CrmJourney");
const { CrmLead, WON_STATUSES, LOST_STATUSES } = require("../models/CrmLead");
const { readSpreadsheet } = require("../utils/spreadsheet");
const contacts = require("./crmEngagementContactService");
const catalog = require("./crmEngagementCatalog");
const logger = require("../utils/logger");

const PRIVATE_DIR = path.join(__dirname, "../storage/imports");
const MAX_ROWS = Math.max(100, Number(process.env.CRM_CONTACT_IMPORT_MAX_ROWS) || 20000);
const ANALYZE_TTL_MS = 24 * catalog.HOUR;
const BATCH = 500;
const MAX_ERRORS = 1000;
const TRIAGE_LEASE_MS = 15 * 60 * 1000;

/** Contact fields a column can map to, with header synonyms for the rule-based mapper. */
const FIELDS = [
  { key: "email", label: "Email address", synonyms: ["email", "emailaddress", "e-mail", "mail", "emailid", "contactemail", "workemail"] },
  { key: "name", label: "Full name", synonyms: ["name", "fullname", "contactname", "customername", "clientname", "leadname", "customer", "client"] },
  { key: "first_name", label: "First name", synonyms: ["firstname", "first", "givenname", "fname"] },
  { key: "last_name", label: "Last name", synonyms: ["lastname", "last", "surname", "familyname", "lname"] },
  { key: "phone", label: "Phone", synonyms: ["phone", "mobile", "phonenumber", "mobilenumber", "contactnumber", "cell", "telephone", "tel", "whatsapp"] },
  { key: "company", label: "Company", synonyms: ["company", "companyname", "organization", "organisation", "business", "employer"] },
  { key: "tags", label: "Tags / segments (comma separated)", synonyms: ["tags", "tag", "segment", "segments", "labels", "group", "groups", "list", "category"] },
  { key: "notes", label: "Notes", synonyms: ["notes", "note", "comments", "comment", "description", "remarks"] },
  { key: "city", label: "City", synonyms: ["city", "town", "location"] },
  { key: "last_activity", label: "Last visit / purchase date", synonyms: ["lastvisit", "lastactivity", "lastpurchase", "lastorder", "lastseen", "lastbooking", "lastvisitdate", "lastcontacted", "lastinteraction"] },
  { key: "email_status", label: "Subscribed / opted out", synonyms: ["subscribed", "emailstatus", "optin", "optout", "unsubscribed", "marketingconsent", "emailconsent", "acceptsmarketing"] },
];
const FIELD_KEYS = FIELDS.map((f) => f.key);
const MULTI_FIELDS = ["tags", "notes"];

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function normalizeHeader(h) {
  return String(h || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Rule-based mapping: exact synonym matches first, then "contains" matches. */
function ruleMapping(headers) {
  const mapping = {};
  const used = new Set();
  for (const pass of ["exact", "contains"]) {
    for (const header of headers) {
      if (mapping[header]) continue;
      const norm = normalizeHeader(header);
      if (!norm) continue;
      const field = FIELDS.find((f) => {
        if (used.has(f.key) && !MULTI_FIELDS.includes(f.key)) return false;
        return pass === "exact" ? f.synonyms.includes(norm) : f.synonyms.some((syn) => syn.length > 3 && norm.includes(syn));
      });
      if (field) {
        mapping[header] = field.key;
        used.add(field.key);
      }
    }
  }
  return mapping;
}

function cleanMapping(headers, mapping = {}) {
  const out = {};
  const used = new Set();
  for (const header of headers) {
    const field = mapping[header];
    if (!field || field === "ignore" || !FIELD_KEYS.includes(field)) continue;
    if (used.has(field) && !MULTI_FIELDS.includes(field)) throw httpError(400, `Two columns are mapped to "${FIELDS.find((f) => f.key === field).label}"`);
    used.add(field);
    out[header] = field;
  }
  if (!used.has("email") && !used.has("phone")) throw httpError(400, "Map a column to Email address (or at least Phone) to import contacts");
  return out;
}

const FALSEY = ["no", "n", "false", "0", "unsubscribed", "opted out", "optout", "opt-out", "opted-out", "unsubscribe", "do not email", "dnc"];

function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date && !isNaN(value)) return value;
  const text = String(value).trim();
  if (!text) return null;
  // dd/mm/yyyy (common outside the US) before letting Date guess.
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  if (dmy) {
    const [, d, m, y] = dmy.map(Number);
    const date = new Date(y, m - 1, d);
    if (d <= 31 && m <= 12 && !isNaN(date)) return date;
  }
  const date = new Date(text);
  return isNaN(date) ? null : date;
}

/**
 * Turns one spreadsheet row into a contact record, or returns errors.
 * @returns {{ record?: object, errors: Array<{field, message, value}> }}
 */
function mapRow(row, mapping, now = new Date()) {
  const get = (field) =>
    Object.entries(mapping)
      .filter(([, f]) => f === field)
      .map(([h]) => String(row[h] ?? "").trim())
      .filter(Boolean);
  const errors = [];
  const rawEmail = get("email")[0] || "";
  const email = rawEmail.toLowerCase().replace(/^mailto:/, "");
  if (rawEmail && !validator.isEmail(email)) errors.push({ field: "email", message: "Invalid email address", value: rawEmail.slice(0, 120) });
  const phone = contacts.normalizePhone(get("phone")[0] || "");
  if (phone && phone.replace(/\D/g, "").length < 7) errors.push({ field: "phone", message: "Phone number is too short", value: phone });
  if (!rawEmail && !phone) errors.push({ field: "email", message: "Row has no email address or phone number", value: "" });
  if (errors.length) return { errors };

  const name = get("name")[0] || [get("first_name")[0], get("last_name")[0]].filter(Boolean).join(" ");
  const tags = get("tags")
    .flatMap((t) => t.split(/[,;|]/))
    .map((t) => t.trim().slice(0, 40))
    .filter(Boolean);
  const lastActivity = parseDate(get("last_activity")[0]);
  const statusText = (get("email_status")[0] || "").toLowerCase();
  return {
    errors,
    record: {
      email: validator.isEmail(email) ? email : "",
      phone,
      name: name.slice(0, 120),
      company: (get("company")[0] || "").slice(0, 120),
      tags: [...new Set(tags)].slice(0, 20),
      notes: get("notes").join("\n").slice(0, 2000),
      city: (get("city")[0] || "").slice(0, 80),
      lastActivityAt: lastActivity && lastActivity <= now ? lastActivity : null,
      unsubscribed: Boolean(statusText) && FALSEY.includes(statusText),
    },
  };
}

function identityKey(record) {
  return record.email ? `e:${record.email}` : `p:${record.phone}`;
}

/** Merges a later duplicate row into an earlier one (later non-empty values win). */
function mergeRecords(a, b) {
  return {
    ...a,
    ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== "" && v !== null && !(Array.isArray(v) && !v.length))),
    tags: [...new Set([...(a.tags || []), ...(b.tags || [])])],
    unsubscribed: a.unsubscribed || b.unsubscribed,
  };
}

function fileTypeFor(name) {
  const ext = path.extname(String(name || "")).toLowerCase();
  if (ext === ".csv") return "csv";
  if (ext === ".xlsx" || ext === ".xls") return "xlsx";
  return null;
}

function removeFile(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (error) {
    logger.warn("crm_contact_import.cleanup_failed", "Could not remove import file", { error: error.message });
  }
}

/** Parses and validates rows with a mapping. Shared by analyze (dry run) and commit. */
function prepareRows(rows, mapping, now = new Date()) {
  const errors = [];
  const byKey = new Map();
  let duplicatesInFile = 0;
  rows.forEach((row, i) => {
    const rowNumber = i + 2; // header is row 1
    const { record, errors: rowErrors } = mapRow(row, mapping, now);
    if (!record) {
      for (const e of rowErrors) errors.push({ row: rowNumber, ...e });
      return;
    }
    const key = identityKey(record);
    if (byKey.has(key)) {
      duplicatesInFile++;
      byKey.set(key, { ...mergeRecords(byKey.get(key), record), row: byKey.get(key).row });
    } else {
      byKey.set(key, { ...record, row: rowNumber });
    }
  });
  const invalidRows = new Set(errors.map((e) => e.row)).size;
  return { records: [...byKey.values()], errors, invalidRows, duplicatesInFile };
}

async function findExisting(businessId, records) {
  const emails = records.filter((r) => r.email).map((r) => r.email);
  const phones = records.filter((r) => !r.email && r.phone).map((r) => r.phone);
  const found = await CrmContact.find({
    businessId,
    $or: [...(emails.length ? [{ email: { $in: emails } }] : []), ...(phones.length ? [{ phone: { $in: phones } }] : [])],
  })
    .sort({ updatedAt: 1 })
    .lean();
  const map = new Map();
  for (const c of found) {
    if (c.email) map.set(`e:${c.email}`, c);
    if (c.phone && !map.has(`p:${c.phone}`)) map.set(`p:${c.phone}`, c);
  }
  return map;
}

// ── Step 1: analyze ─────────────────────────────────────────────────────────

/**
 * Stores the upload privately, reads it and returns the preview, suggested mapping
 * and dry-run counts. `file` is a multer file ({ path, originalname }).
 */
async function analyzeImport({ business, file, userId, useAi = true }) {
  const fileType = fileTypeFor(file?.originalname);
  if (!file || !fileType) {
    removeFile(file?.path);
    throw httpError(400, "Upload a CSV or Excel (.xlsx) file");
  }
  fs.mkdirSync(PRIVATE_DIR, { recursive: true });
  const storedPath = path.join(PRIVATE_DIR, `${new mongoose.Types.ObjectId()}${path.extname(file.originalname).toLowerCase()}`);
  try {
    fs.renameSync(file.path, storedPath);
  } catch {
    fs.copyFileSync(file.path, storedPath);
    removeFile(file.path);
  }

  let parsed;
  try {
    parsed = await readSpreadsheet(storedPath, fileType, { maxRows: MAX_ROWS });
  } catch (error) {
    removeFile(storedPath);
    throw httpError(400, `Could not read the file: ${error.message}`);
  }
  if (!parsed.headers.length || !parsed.rows.length) {
    removeFile(storedPath);
    throw httpError(400, "The file has no header row or no data rows");
  }

  let mapping = ruleMapping(parsed.headers);
  let mappedBy = "rules";
  const unmapped = parsed.headers.filter((h) => !mapping[h]);
  if (useAi && unmapped.length && require("./crmEngagementAiService").isConfigured()) {
    try {
      const ai = await require("./crmEngagementAiService").suggestMapping(parsed.headers, FIELDS);
      // Rules win where they matched; AI fills the gaps (and fixes a missing email column).
      const used = new Set(Object.values(mapping));
      for (const [header, field] of Object.entries(ai)) {
        if (mapping[header]) continue;
        if (used.has(field) && !MULTI_FIELDS.includes(field)) continue;
        mapping[header] = field;
        used.add(field);
        mappedBy = "ai";
      }
    } catch (error) {
      logger.warn("crm_contact_import.ai_mapping_failed", "AI column mapping failed; using rules", { error: error.message });
    }
  }

  let dryRun = null;
  try {
    const safeMapping = cleanMapping(parsed.headers, mapping);
    const prepared = prepareRows(parsed.rows, safeMapping);
    const existing = await findExisting(business._id, prepared.records);
    dryRun = {
      validContacts: prepared.records.length,
      invalidRows: prepared.invalidRows,
      duplicatesInFile: prepared.duplicatesInFile,
      matchesExisting: prepared.records.filter((r) => existing.has(identityKey(r))).length,
      withEmail: prepared.records.filter((r) => r.email).length,
      sampleErrors: prepared.errors.slice(0, 10),
    };
  } catch (error) {
    dryRun = { error: error.message };
  }

  const doc = await CrmContactImport.create({
    ownerId: business.userId,
    businessId: business._id,
    createdBy: userId,
    fileName: String(file.originalname).slice(0, 200),
    storedPath,
    status: "analyzed",
    rowCount: parsed.rows.length,
    headers: parsed.headers,
    suggestedMapping: mapping,
    mappedBy,
  });
  logger.info("crm_contact_import.analyzed", "Contact import analyzed", { importId: String(doc._id), businessId: String(business._id), rows: parsed.rows.length });
  return {
    importId: doc._id,
    fileName: doc.fileName,
    rowCount: parsed.rows.length,
    truncated: parsed.truncated,
    maxRows: MAX_ROWS,
    headers: parsed.headers,
    // First rows so the owner can check the mapping; values stay on their own screen.
    preview: parsed.rows.slice(0, 5),
    suggestedMapping: mapping,
    mappedBy,
    fields: FIELDS.map(({ key, label }) => ({ key, label })),
    dryRun,
  };
}

/** Re-runs the dry run for a changed mapping (no writes). */
async function validateMapping({ businessId, importId, mapping }) {
  const doc = await loadImport(businessId, importId, { withPath: true });
  if (doc.status !== "analyzed") throw httpError(400, "This import has already been processed");
  const safeMapping = cleanMapping(doc.headers, mapping);
  const parsed = await readSpreadsheet(doc.storedPath, fileTypeFor(doc.storedPath), { maxRows: MAX_ROWS });
  const prepared = prepareRows(parsed.rows, safeMapping);
  const existing = await findExisting(businessId, prepared.records);
  return {
    validContacts: prepared.records.length,
    invalidRows: prepared.invalidRows,
    duplicatesInFile: prepared.duplicatesInFile,
    matchesExisting: prepared.records.filter((r) => existing.has(identityKey(r))).length,
    withEmail: prepared.records.filter((r) => r.email).length,
    sampleErrors: prepared.errors.slice(0, 10),
  };
}

async function loadImport(businessId, importId, { withPath = false } = {}) {
  if (!mongoose.isValidObjectId(importId)) throw httpError(404, "Import not found");
  const q = CrmContactImport.findOne({ _id: importId, businessId });
  if (withPath) q.select("+storedPath");
  const doc = await q;
  if (!doc) throw httpError(404, "Import not found");
  if (doc.status === "analyzed" && Date.now() - doc.createdAt.getTime() > ANALYZE_TTL_MS) {
    removeFile(doc.storedPath);
    doc.status = "expired";
    doc.storedPath = null;
    await doc.save();
  }
  if (doc.status === "expired") throw httpError(410, "This upload expired. Please upload the file again.");
  return doc;
}

// ── Step 2: commit ──────────────────────────────────────────────────────────

function normalizeOptions(input = {}) {
  const duplicateMode = ["fill_empty", "overwrite", "skip"].includes(input.duplicateMode) ? input.duplicateMode : "fill_empty";
  const tags = (Array.isArray(input.tags) ? input.tags : String(input.tags || "").split(","))
    .map((t) => String(t).trim().slice(0, 40))
    .filter(Boolean)
    .slice(0, 10);
  return {
    duplicateMode,
    tags,
    consentConfirmed: input.consentConfirmed === true,
    engagement: input.engagement === "none" ? "none" : "auto",
  };
}

/** Field updates for an existing contact, per duplicate mode. Never touches activity or opt-outs. */
function updateForExisting(existing, record, options, now) {
  const set = {};
  const fill = (field, value) => {
    if (!value) return;
    if (options.duplicateMode === "overwrite" || !existing[field]) set[field] = value;
  };
  if (options.duplicateMode !== "skip") {
    fill("name", record.name);
    fill("company", record.company);
    if (!existing.phone && record.phone) set.phone = record.phone;
    if (record.city && (options.duplicateMode === "overwrite" || !existing.address?.city)) set["address.city"] = record.city;
    if (record.notes) set.notes = existing.notes ? `${existing.notes}\n${record.notes}`.slice(0, 5000) : record.notes;
    if (record.lastActivityAt && (!existing.engagement?.lastActivityAt || record.lastActivityAt > new Date(existing.engagement.lastActivityAt))) {
      set["engagement.lastActivityAt"] = record.lastActivityAt;
    }
    if (options.consentConfirmed && (existing.consent?.basis || "unknown") === "unknown") {
      set.consent = { basis: "import_confirmed", capturedAt: now };
    }
    if (!existing.emailKey && existing.email && existing.businessId) set.emailKey = contacts.emailKeyFor(existing.businessId, existing.email);
  }
  // Opt-outs in the file are always honoured, whatever the duplicate mode.
  if (record.unsubscribed && existing.emailStatus === "subscribed") {
    set.emailStatus = "unsubscribed";
    set.emailStatusChangedAt = now;
  }
  const tags = [...(options.duplicateMode === "skip" ? [] : [...options.tags, ...(record.tags || [])])];
  const update = {};
  if (Object.keys(set).length) update.$set = set;
  if (tags.length) update.$addToSet = { tags: { $each: [...new Set(tags)] } };
  return update;
}

/**
 * Imports the contacts. Returns the import summary. Imported contacts that may be
 * emailed are queued for engagement triage.
 */
async function commitImport({ business, importId, mapping, options: rawOptions, userId }) {
  const options = normalizeOptions(rawOptions);
  const doc = await loadImport(business._id, importId, { withPath: true });
  if (doc.status !== "analyzed") throw httpError(400, "This import has already been processed");
  const safeMapping = cleanMapping(doc.headers, mapping || doc.suggestedMapping);
  const claimed = await CrmContactImport.findOneAndUpdate(
    { _id: doc._id, status: "analyzed" },
    { $set: { status: "processing", mapping: safeMapping, options } },
    { new: true }
  );
  if (!claimed) throw httpError(409, "This import is already being processed");

  const now = new Date();
  const summary = { created: 0, updated: 0, unchanged: 0, invalid: 0, duplicatesInFile: 0, suppressed: 0 };
  const rowErrors = [];
  const eligibleForTriage = options.consentConfirmed && options.engagement === "auto";
  try {
    const parsed = await readSpreadsheet(doc.storedPath, fileTypeFor(doc.storedPath), { maxRows: MAX_ROWS });
    const prepared = prepareRows(parsed.rows, safeMapping, now);
    summary.invalid = prepared.invalidRows;
    summary.duplicatesInFile = prepared.duplicatesInFile;
    rowErrors.push(...prepared.errors.slice(0, MAX_ERRORS));

    for (let i = 0; i < prepared.records.length; i += BATCH) {
      const batch = prepared.records.slice(i, i + BATCH);
      const existing = await findExisting(business._id, batch);
      const updates = [];
      const inserts = [];
      const updatedIds = [];
      for (const record of batch) {
        const match = existing.get(identityKey(record));
        if (match) {
          const update = updateForExisting(match, record, options, now);
          if (update.$set?.emailStatus === "unsubscribed") summary.suppressed++;
          if (Object.keys(update).length) {
            updates.push({ updateOne: { filter: { _id: match._id }, update } });
            updatedIds.push(match._id);
          } else {
            summary.unchanged++;
          }
          continue;
        }
        if (record.unsubscribed) summary.suppressed++;
        const consentBasis = options.consentConfirmed ? "import_confirmed" : "unknown";
        const marketable = eligibleForTriage && record.email && !record.unsubscribed;
        const draft = {
          lastActivityAt: record.lastActivityAt,
          engagement: { lastActivityAt: record.lastActivityAt, activityCount: record.lastActivityAt ? 1 : 0 },
        };
        inserts.push({
          ownerId: business.userId,
          businessId: business._id,
          name: record.name,
          email: record.email,
          emailKey: contacts.emailKeyFor(business._id, record.email),
          phone: record.phone,
          company: record.company,
          notes: record.notes,
          address: { street: "", city: record.city || "", state: "", zip: "", country: "" },
          source: "Import",
          tags: [...new Set([...options.tags, ...record.tags])],
          consent: { basis: consentBasis, capturedAt: options.consentConfirmed ? now : null },
          emailStatus: record.unsubscribed ? "unsubscribed" : "subscribed",
          emailStatusChangedAt: record.unsubscribed ? now : null,
          engagement: {
            lastActivityAt: record.lastActivityAt,
            lastActivityType: record.lastActivityAt ? "contact_imported" : "",
            activityCount: 0,
            emailsSent: 0,
          },
          lifecycle: catalog.computeLifecycle(draft, now),
          triage: marketable ? { status: "pending", importId: doc._id, reason: "", decidedAt: null, decidedBy: null } : { status: null },
        });
      }
      if (updates.length) {
        const res = await CrmContact.bulkWrite(updates, { ordered: false });
        summary.updated += res.modifiedCount || 0;
        summary.unchanged += updates.length - (res.modifiedCount || 0);
      }
      let createdDocs = [];
      if (inserts.length) {
        try {
          createdDocs = await CrmContact.insertMany(inserts, { ordered: false });
        } catch (error) {
          // Rows that raced with another write (duplicate emailKey) are skipped; the rest are kept.
          createdDocs = error.insertedDocs || [];
          const failed = inserts.length - createdDocs.length;
          summary.unchanged += failed;
          if (!error.writeErrors && !error.code) throw error;
        }
        summary.created += createdDocs.length;
      }
      if (createdDocs.length) {
        await CrmContactActivity.insertMany(
          createdDocs.map((c) => ({
            ownerId: business.userId,
            businessId: business._id,
            contactId: c._id,
            type: "contact_imported",
            summary: `Imported from ${doc.fileName}`.slice(0, 300),
            meta: { importId: doc._id },
            occurredAt: now,
            lastOccurredAt: now,
          })),
          { ordered: false }
        );
        await linkLeads(business._id, createdDocs);
      }
      if (updatedIds.length) {
        await CrmContactActivity.insertMany(
          updatedIds.map((id) => ({
            ownerId: business.userId,
            businessId: business._id,
            contactId: id,
            type: "contact_updated",
            summary: `Updated by import of ${doc.fileName}`.slice(0, 300),
            meta: { importId: doc._id },
            occurredAt: now,
            lastOccurredAt: now,
          })),
          { ordered: false }
        );
      }
    }

    const pending = eligibleForTriage ? await CrmContact.countDocuments({ "triage.importId": doc._id, "triage.status": "pending" }) : 0;
    await CrmContactImport.updateOne(
      { _id: doc._id },
      {
        $set: {
          status: "completed",
          summary,
          rowErrors,
          completedAt: new Date(),
          storedPath: null,
          "triage.status": pending ? "pending" : "none",
        },
      }
    );
    removeFile(doc.storedPath);
    logger.info("crm_contact_import.completed", "Contact import completed", { importId: String(doc._id), businessId: String(business._id), ...summary, pendingTriage: pending });

    if (pending) {
      // Review right away; the worker sweep retries if this process stops first.
      setImmediate(() => {
        runTriageForImport(doc._id).catch((error) =>
          logger.error("crm_contact_import.triage_failed", "Import triage failed", { importId: String(doc._id), error: error.message })
        );
      });
    }
    return { importId: doc._id, summary, errors: rowErrors.slice(0, 100), errorCount: rowErrors.length, triage: { status: pending ? "pending" : "none", pending } };
  } catch (error) {
    await CrmContactImport.updateOne({ _id: doc._id }, { $set: { status: "failed", failureReason: error.message, summary, rowErrors, storedPath: null } });
    removeFile(doc.storedPath);
    logger.error("crm_contact_import.failed", "Contact import failed", { importId: String(doc._id), error: error.message });
    throw httpError(500, "The import failed part-way. Contacts already processed were kept; please check the import history.");
  }
}

/** Links newly created contacts to the business's existing leads with the same email. */
async function linkLeads(businessId, created) {
  const emails = created.map((c) => c.email).filter(Boolean);
  if (!emails.length) return;
  const leads = await CrmLead.find({ businessId, email: { $in: emails } }).select("_id email").lean();
  if (!leads.length) return;
  const byEmail = Object.fromEntries(leads.map((l) => [l.email, l._id]));
  const ops = created
    .filter((c) => byEmail[c.email])
    .map((c) => ({ updateOne: { filter: { _id: c._id, leadId: null }, update: { $set: { leadId: byEmail[c.email], lifecycle: "lead" } } } }));
  if (ops.length) await CrmContact.bulkWrite(ops, { ordered: false });
}

// ── Triage ──────────────────────────────────────────────────────────────────

function recencyBucket(lastActivityAt, now) {
  if (!lastActivityAt) return "unknown";
  const days = (now - new Date(lastActivityAt)) / catalog.DAY;
  if (days <= 30) return "0-30d";
  if (days <= 90) return "31-90d";
  if (days <= 365) return "91-365d";
  return "365d+";
}

const RECENCY_TEXT = {
  unknown: "no known last activity",
  "0-30d": "last active within 30 days",
  "31-90d": "last active 1-3 months ago",
  "91-365d": "last active 3-12 months ago",
  "365d+": "last active over a year ago",
};

/** Anonymous segment for a contact: recency, customer/lead state and main tag. */
function segmentOf(contact, leadStatus, now) {
  const recency = recencyBucket(contact.engagement?.lastActivityAt, now);
  let relation = "none";
  if ((contact.bookings?.count || 0) > 0 || WON_STATUSES.includes(leadStatus)) relation = "customer";
  else if (LOST_STATUSES.includes(leadStatus)) relation = "lost_lead";
  else if (leadStatus) relation = "open_lead";
  const tag = [...(contact.tags || [])].sort()[0] || "";
  const key = [recency, relation, tag].join("|");
  const parts = [RECENCY_TEXT[recency]];
  if (relation === "customer") parts.push("existing customer");
  if (relation === "open_lead") parts.push("open lead in the pipeline");
  if (relation === "lost_lead") parts.push("marked lost in the pipeline");
  if (tag) parts.push(`tagged "${tag}"`);
  return { key, recency, relation, tag, description: parts.join(", ") };
}

/**
 * Rule-based triage, used without AI or when the AI fails. Prefers doing nothing
 * over an email that doesn't fit.
 */
function ruleDecision(segment, candidates) {
  const intro = candidates.find((j) => j.trigger.signal === "contact_imported");
  const winBack = candidates.find((j) => j.trigger.signal === "inactive");
  if (segment.relation === "lost_lead") return { action: "wait", reason: "Marked lost in your pipeline; waiting for them to show interest again." };
  if (segment.recency === "0-30d") {
    return segment.relation === "customer"
      ? { action: "wait", reason: "Recently active customers don't need an introduction." }
      : intro
        ? { action: "enroll", journeyId: String(intro._id), reason: "Recently active: a short hello while you're fresh in mind." }
        : { action: "wait", reason: "No introduction journey is switched on." };
  }
  if (["91-365d", "365d+"].includes(segment.recency) || (segment.recency === "31-90d" && segment.relation === "customer")) {
    if (winBack) return { action: "enroll", journeyId: String(winBack._id), reason: "Quiet for a while: a win-back email fits best." };
    if (intro) return { action: "enroll", journeyId: String(intro._id), reason: "Quiet for a while and no win-back journey is on: a gentle reintroduction." };
    return { action: "wait", reason: "No win-back or introduction journey is switched on." };
  }
  if (intro) return { action: "enroll", journeyId: String(intro._id), reason: "No history with you yet: a low-pressure introduction." };
  return { action: "wait", reason: "No introduction journey is switched on; they'll be engaged when they next interact." };
}

/**
 * Reviews the pending contacts of one import: builds segments, decides per segment
 * (AI or rules), and enrols contacts or leaves them waiting. Safe to call twice:
 * a lease prevents parallel runs.
 */
async function runTriageForImport(importId, { now = new Date(), client } = {}) {
  const doc = await CrmContactImport.findOneAndUpdate(
    {
      _id: importId,
      $or: [{ "triage.status": "pending" }, { "triage.status": "running", "triage.startedAt": { $lt: new Date(now.getTime() - TRIAGE_LEASE_MS) } }],
    },
    { $set: { "triage.status": "running", "triage.startedAt": now } },
    { new: true }
  ).lean();
  if (!doc) return null;

  const journeys = require("./crmJourneyService");
  const ai = require("./crmEngagementAiService");
  try {
    const settings = await contacts.getSettings(doc.businessId);
    const pending = await CrmContact.find({ "triage.importId": doc._id, "triage.status": "pending" }).limit(MAX_ROWS).lean();
    const finishAll = async (reason, decidedBy = "rules") => {
      await CrmContact.updateMany(
        { "triage.importId": doc._id, "triage.status": "pending" },
        { $set: { "triage.status": "waiting", "triage.reason": reason, "triage.decidedAt": now, "triage.decidedBy": decidedBy } }
      );
      await CrmContactImport.updateOne(
        { _id: doc._id },
        { $set: { "triage.status": "done", "triage.decidedBy": decidedBy, "triage.segments": [{ key: "all", description: "All imported contacts", count: pending.length, action: "wait", reason }], "triage.enrolled": 0, "triage.waiting": pending.length, "triage.completedAt": new Date(), "triage.error": null } }
      );
      return { enrolled: 0, waiting: pending.length };
    };
    if (!pending.length) return finishAll("Nothing to review");
    if (!settings.enabled) return finishAll("Engagement emails are switched off for this business. Switch them on and review this import again.");
    const candidates = await CrmJourney.find({ businessId: doc.businessId, isEnabled: true, "trigger.signal": { $in: ["contact_imported", "inactive"] } }).lean();
    if (!candidates.length) return finishAll("No journey for imported or inactive contacts is switched on. Switch one on and review this import again.");

    const leadIds = pending.map((c) => c.leadId).filter(Boolean);
    const leads = leadIds.length ? await CrmLead.find({ _id: { $in: leadIds } }).select("_id status").lean() : [];
    const leadStatus = Object.fromEntries(leads.map((l) => [String(l._id), l.status]));
    const segments = new Map();
    const contactSegment = new Map();
    for (const c of pending) {
      const seg = segmentOf(c, c.leadId ? leadStatus[String(c.leadId)] : null, now);
      if (!segments.has(seg.key)) segments.set(seg.key, { ...seg, count: 0 });
      segments.get(seg.key).count++;
      contactSegment.set(String(c._id), seg.key);
    }
    const segmentList = [...segments.values()];

    let decidedBy = "rules";
    let decisions = {};
    if (settings.aiTriage && (client || ai.isConfigured())) {
      try {
        const aiDecisions = await ai.triageSegments({ businessId: doc.businessId, segments: segmentList, candidates }, { client });
        decisions = Object.fromEntries(aiDecisions.map((d) => [d.segment, d]));
        decidedBy = "ai";
      } catch (error) {
        logger.warn("crm_contact_import.ai_triage_failed", "AI triage failed; using rules", { importId: String(doc._id), error: error.message });
      }
    }
    for (const seg of segmentList) {
      if (!decisions[seg.key]) decisions[seg.key] = { ...ruleDecision(seg, candidates), by: "rules" };
    }

    const byId = Object.fromEntries(candidates.map((j) => [String(j._id), j]));
    let enrolled = 0;
    let waiting = 0;
    for (const c of pending) {
      const decision = decisions[contactSegment.get(String(c._id))];
      let status = "waiting";
      let reason = decision.reason;
      if (decision.action === "enroll" && byId[decision.journeyId]) {
        const journey = byId[decision.journeyId];
        const res = await journeys.enroll(c, journey, {
          signal: journey.trigger.signal,
          context: { importId: doc._id, decidedBy: decision.by || decidedBy, reason },
          now,
          advance: false,
        });
        if (res.enrollment) status = "enrolled";
        else reason = `${reason} (not started: ${res.skipped})`;
      }
      if (status === "enrolled") enrolled++;
      else waiting++;
      await CrmContact.updateOne(
        { _id: c._id },
        { $set: { "triage.status": status, "triage.reason": String(reason).slice(0, 300), "triage.decidedAt": now, "triage.decidedBy": decision.by || decidedBy } }
      );
    }
    const segmentSummary = segmentList.map((s) => ({
      key: s.key,
      description: s.description,
      count: s.count,
      action: decisions[s.key].action,
      journeyName: byId[decisions[s.key].journeyId]?.name || null,
      reason: decisions[s.key].reason,
      decidedBy: decisions[s.key].by || decidedBy,
    }));
    await CrmContactImport.updateOne(
      { _id: doc._id },
      { $set: { "triage.status": "done", "triage.decidedBy": decidedBy, "triage.segments": segmentSummary, "triage.enrolled": enrolled, "triage.waiting": waiting, "triage.completedAt": new Date(), "triage.error": null } }
    );
    logger.info("crm_contact_import.triaged", "Imported contacts reviewed for engagement", { importId: String(doc._id), decidedBy, enrolled, waiting, segments: segmentList.length });
    return { enrolled, waiting, decidedBy };
  } catch (error) {
    await CrmContactImport.updateOne({ _id: doc._id }, { $set: { "triage.status": "pending", "triage.error": error.message } });
    throw error;
  }
}

/** Owner asks to review an import's waiting contacts again (e.g. after switching journeys on). */
async function retriage({ businessId, importId }) {
  const doc = await loadImport(businessId, importId);
  if (doc.status !== "completed") throw httpError(400, "Only completed imports can be reviewed again");
  if (!doc.options?.consentConfirmed) throw httpError(400, "This import was made without email permission, so its contacts can't enter journeys");
  const res = await CrmContact.updateMany(
    { "triage.importId": doc._id, "triage.status": "waiting", emailStatus: "subscribed" },
    { $set: { "triage.status": "pending" } }
  );
  if (!res.modifiedCount) return { queued: 0 };
  await CrmContactImport.updateOne({ _id: doc._id }, { $set: { "triage.status": "pending", "triage.error": null } });
  return { queued: res.modifiedCount, result: await runTriageForImport(doc._id) };
}

/** Sweep: pending triage (at most 2 imports per sweep) and expired uploads. */
async function runPendingTriage({ now = new Date() } = {}) {
  const stale = await CrmContactImport.find({ status: "analyzed", createdAt: { $lt: new Date(now.getTime() - ANALYZE_TTL_MS) } }).select("+storedPath").limit(50);
  for (const doc of stale) {
    removeFile(doc.storedPath);
    await CrmContactImport.updateOne({ _id: doc._id }, { $set: { status: "expired", storedPath: null } });
  }
  const due = await CrmContactImport.find({
    $or: [{ "triage.status": "pending" }, { "triage.status": "running", "triage.startedAt": { $lt: new Date(now.getTime() - TRIAGE_LEASE_MS) } }],
  })
    .sort({ createdAt: 1 })
    .limit(2)
    .select("_id")
    .lean();
  const results = [];
  for (const { _id } of due) results.push(await runTriageForImport(_id, { now }));
  return { expired: stale.length, triaged: results.filter(Boolean).length };
}

async function listImports(businessId, query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.max(1, Math.min(50, parseInt(query.limit, 10) || 10));
  const filter = { businessId, status: { $ne: "analyzed" } };
  const [total, imports] = await Promise.all([
    CrmContactImport.countDocuments(filter),
    CrmContactImport.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).select("-rowErrors").lean(),
  ]);
  return { imports, total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
}

async function getImport(businessId, importId) {
  if (!mongoose.isValidObjectId(importId)) throw httpError(404, "Import not found");
  const doc = await CrmContactImport.findOne({ _id: importId, businessId }).lean();
  if (!doc) throw httpError(404, "Import not found");
  return doc;
}

/** CSV of the rows that could not be imported, for the owner to fix and re-upload. */
async function errorsCsv(businessId, importId) {
  const doc = await getImport(businessId, importId);
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""').replace(/^[=+\-@]/, "'$&")}"`;
  const lines = ["row,field,problem,value", ...(doc.rowErrors || []).map((e) => [e.row, e.field, e.message, e.value].map(esc).join(","))];
  return { fileName: `import-errors-${doc._id}.csv`, csv: lines.join("\n") };
}

module.exports = {
  FIELDS,
  PRIVATE_DIR,
  ruleMapping,
  cleanMapping,
  mapRow,
  prepareRows,
  parseDate,
  normalizeOptions,
  updateForExisting,
  segmentOf,
  ruleDecision,
  analyzeImport,
  validateMapping,
  commitImport,
  runTriageForImport,
  retriage,
  runPendingTriage,
  listImports,
  getImport,
  errorsCsv,
};
