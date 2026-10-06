# Cloudinary image storage (Category and SubCategory icons)

Status: implemented and tested locally on 2026-10-06. **Not deployed. Production MongoDB and the
production Cloudinary folder (`urbancitations/`) were not changed.**

## Architecture

```
Admin  →  backend upload API (multer, memory)  →  validate bytes  →  Cloudinary (signed, server-side)
       →  secure_url + public_id stored in MongoDB  →  Admin / public frontend read `iconUrl` from the API
       →  Cloudinary serves the image
```

New icon uploads never touch Git, `public/uploads`, `/srv/urbancitations/uploads` or any
server-local path. A deploy (`rsync --delete`) therefore cannot delete them.

Legacy records keep working unchanged: an `iconUrl` that points at `/uploads/<file>` is still
served by Nginx from `/srv/urbancitations/uploads` until it is migrated (Phase 12).

## Code

| File | Role |
|---|---|
| `services/imageStorageService.js` | Cloudinary service: configure, validate, upload, delete, reference counting, replace/remove helpers |
| `services/imageStorageService.test.js` | Unit tests (Cloudinary SDK stubbed) |
| `models/schemas/imageAsset.js` | `ImageAssetSchema` sub-document |
| `models/Category.js`, `models/SubCategory.js` | new `icon` field; register the field for reference counting |
| `utils/uploadValidation.js` | buffer support + `validateImageBuffer()` |
| `config/multerConfig.js` | `memoryUpload` (memory storage, 5 MB limit, same validation) |
| `routes/categoryRoutes.js`, `routes/subCategoryRoutes.js` | icon routes use `memoryUpload`; CSV imports unchanged |
| `controllers/categoryController.js`, `controllers/subCategoryContoller.js` | create / replace / remove / delete flows |
| `scripts/migrateSubcategoryIconsToCloudinary.js` | migration of the recreated icon set (dry-run / apply / rollback) |
| Admin: `src/views/pages/services/EditServiceCategory.js`, `EditServiceSubcategory.js` | preview from API response, cancel replacement, remove icon |

The public frontend (`business_listing`) needed no change: every consumer renders `iconUrl`
as returned by the API (or guards with `startsWith("http")` before prefixing `VITE_IMAGE_URL`),
so Cloudinary URLs are used as-is and no `/uploads/<file>` path is constructed for them.

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | yes (already present in the backend `.env`) | signed server-side uploads |
| `CLOUDINARY_ROOT_FOLDER` | no, default `urbancitations` | root folder of every asset; local tests use another value so they never mix with production assets |
| `IMAGE_UPLOAD_MAX_BYTES` | no, default `5242880` (5 MB) | hard size limit for icon uploads |

## Cloudinary folder structure

```
<CLOUDINARY_ROOT_FOLDER>/                      default: urbancitations/
  categories/<sha256>                          Category icons
  subcategories/<sha256>                       SubCategory icons
  banners/, top-banner-categories/, top-services/, free-listings/,
  popular-searches/, top-countries/, blog/     reserved for the other entities (not migrated yet)
```

`public_id` = `<root>/<folder>/<SHA-256 of the bytes>`, uploaded with `overwrite: false`.
Identical bytes therefore map to one asset (Cloudinary answers `existing: true` instead of
storing a duplicate), which makes the migration idempotent and makes "is this asset still
referenced?" a plain query on `icon.publicId`.

## Database

`iconUrl` (String) stays the display URL every consumer already reads. For Cloudinary-backed
icons it equals `icon.url`. New sub-document on Category and SubCategory:

```
icon: {
  provider: "cloudinary", url, publicId, resourceType, format, width, height, bytes, version,
  sha256,            // of the uploaded bytes; the public_id is derived from it
  uploadedAt,
  legacyUrl          // the /uploads/<file> URL this asset replaced (migration rollback / audit)
}
```

Legacy records (no `icon`) and default placeholders are untouched. Nothing was removed from
the schema; existing API responses gain the `icon` object and keep every previous field.

## Flows

**Upload (create):** validate (extension, MIME, magic bytes, embedded `<?php`/`<script>`/`<html>`/`<iframe>`,
size) → upload to Cloudinary → `icon` + `iconUrl` set on the new document → save.
Upload failure → HTTP 502 with the Cloudinary message, no document created, no local file.
Save failure → the just-uploaded asset is deleted again unless another document already uses it.

**Replace:** validate → upload NEW → save document → re-read the stored document and verify it
points at the new `publicId` → only then delete the OLD asset, and only when no Category or
SubCategory still references it (shared assets are kept). A failed upload leaves the old icon
untouched. The response carries `imageChange: { verified, release: { status } }`.

**Remove (`removeIcon=true` on PUT):** document reset to the schema default placeholder, then
the old asset is released with the same reference check.

**Delete record:** document deleted first, then the asset is released if unreferenced.
Cloudinary failures during release are logged and reported (`imageRelease.status: "failed"`),
never fatal: the DB is already consistent. Legacy `/uploads` files are never deleted.

## Migration of the recreated subcategory icon set

Input: `recovered-uploads/reports/recreated-icons-final.csv` (2,162 rows → 1,408 unique artworks)
and `recovered-uploads/recreated-subcategory-icons/`.

```bash
cd business_listing_backend

# 1. dry run: inspects every file, hashes, validates the mapping and the DB match; NO changes
node scripts/migrateSubcategoryIconsToCloudinary.js

# 2. sample batch (artworks used by the listed filenames, plus every filename sharing them)
node scripts/migrateSubcategoryIconsToCloudinary.js --only sample.txt --apply --production

# 3. full set
node scripts/migrateSubcategoryIconsToCloudinary.js --apply --production

# resume after an interruption: same command (already-migrated docs skipped, uploads cached)
# rollback the DB part (assets are kept):
node scripts/migrateSubcategoryIconsToCloudinary.js --rollback scripts/backups/<file>.json --apply --production
```

Gate printed by every run; `--apply` refuses unless it reads exactly:

```
EXPECTED UNIQUE ARTWORKS: 1,408   found in CSV/disk: 1,408
EXPECTED SERVER FILENAMES: 2,162   found in CSV: 2,162
MISSING LOCAL FILES: 0
INVALID FILES: 0
AMBIGUOUS MAPPINGS: 0
```

Per artwork: upload once → HEAD the `secure_url` → update every referencing document with a
guard on its current `iconUrl` → read back and verify. Reports: `recovered-uploads/reports/cloudinary-migration/`
(`dry-run-*.csv`, `apply-*.csv` with document id, category, subcategory, old reference, new
public_id, new URL, SHA-256, status) and `state.json` (upload cache). Backups of every document
about to change: `scripts/backups/subcategory-icons-cloudinary-<timestamp>.json` (gitignored).

`--apply` against a non-localhost MongoDB additionally requires `--production`.

## Local test isolation used on 2026-10-06

Local and production share one Atlas database and one Cloudinary account, so tests ran against
a throw-away mongod (`127.0.0.1:27999/uc_cloudinary_test`, seeded from a read-only copy of the
live categories/subcategories) and the Cloudinary roots `urbancitations-localtest/` (API and
browser tests) and `urbancitations-localtest-migration/` (migration rehearsal). Test backends ran
on ports 8010 and 8011 (wrong secret, to exercise Cloudinary failures). All test assets were
deleted afterwards; the user's own backend (:8000) and site (:5173) were not touched.

## Rollback

* Code: revert the files listed above (no commit was made).
* Database (migration): `--rollback <backup.json> --apply [--production]` restores `iconUrl` and
  removes `icon` for every document in the backup. The legacy `/uploads` files were never deleted,
  so the old URLs work again immediately.
* Cloudinary: assets are left in place on rollback (they are harmless). To remove a whole run:
  `cloudinary.api.delete_resources_by_prefix("<root>/subcategories/")` then `api.delete_folder`.

## Retiring the legacy filesystem (later, separately)

Keep `/srv/urbancitations/uploads` and the Nginx `/uploads/` location until every record with a
`/uploads/` URL is migrated and publicly verified. Other entities (banners, top-banner cards,
top services, free listings, popular searches, countries, blog, business logos/photos, email
attachments) still write to the upload directory; the same service and `memoryUpload` can move
them one entity at a time.

## Local test results (2026-10-06)

All tests ran against the isolated stack described above. Nothing was written to production.

| Suite | Result |
|---|---|
| Backend unit tests (`npm test`, includes 8 new `imageStorageService` tests) | 272 / 272 pass |
| API end-to-end on the isolated backend (create, read endpoints, dedupe, replace with shared asset kept, replace with last reference deleted, 8 invalid-file cases, remove icon, re-add JPEG, DB-save failure after upload, Cloudinary failure on create and on replace, delete with shared and unshared assets, category create/replace/delete) | 48 / 48 pass |
| Browser: Admin (login, add, list, refresh, open record, cancel replacement, replace, reopen, remove, re-add) and public site (category page desktop + 390 px mobile, More Categories page for the migrated sample) | 21 / 21 pass |
| Browser: Admin delete record → asset released | 4 / 4 pass |
| Migration dry run, full set, live Atlas data read-only | 1,408 / 2,162 / 0 missing / 0 invalid / 0 ambiguous, "Ready for --apply" |
| Migration sample (10 artworks → 26 filenames) on the local DB copy | 10 uploads, 26 MIGRATED, re-run = nothing to do, rollback restored 26, re-apply from cache 26 |
| Migration full rehearsal on the local DB copy | 1,398 + 10 uploads, 2,162 MIGRATED, 0 failed; distinct assets 1,408; docs-per-asset histogram identical to the CSV; 25 mojibake-named files and 3 JPEGs migrated; re-run = 2,162 ALREADY_MIGRATED |

Artifacts: `recovered-uploads/reports/cloudinary-migration/` (production dry-run report and the
local rehearsal reports, logs and DB backups under `local-rehearsal-2026-10-06/`) and
`recovered-uploads/local-qa/cloudinary-e2e-2026-10-06/` (results JSON, screenshots, test scripts).
