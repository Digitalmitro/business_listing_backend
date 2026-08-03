# UrbanCitations backend API reference

This document describes the HTTP routes currently mounted by `server.js`. It was verified against `server.js`, `routes/*.js`, and the corresponding controllers on 2026-08-03.

## Quick start

```sh
npm install
cp .env.example .env
npm start
```

The default local base URL is `http://localhost:5000`. Set `PORT` to use a different port.

## Request conventions

- JSON requests use `Content-Type: application/json`.
- File endpoints use `multipart/form-data`; their field names are listed below.
- Uploaded files are served from `GET /uploads/<filename>`.
- The default JSON body limit is 2 MB and can be changed with `JSON_BODY_LIMIT`.
- Authenticated routes require `Authorization: Bearer <jwt>`.
- User JWTs are issued by `POST /api/auth/login` and Google login. Admin JWTs are issued only after `POST /admin/verify-otp`.
- `authMiddleware` accepts a valid user or admin JWT and sets `req.user` and `req.tenantId`. A `JWT` label below does not imply an admin-role check unless explicitly stated.
- List endpoints do not share one pagination contract. Common query fields are `page`, `limit`, `search`, `status`, and date filters; see each endpoint entry.
- Every response receives an `X-Request-ID` header.

Global 404 and error responses use these shapes:

```json
{
  "success": false,
  "message": "Route not found",
  "requestId": "..."
}
```

```json
{
  "success": false,
  "message": "Request failed",
  "errorId": "...",
  "requestId": "..."
}
```

### Access labels

| Label | Meaning |
| --- | --- |
| Public | No authentication middleware is mounted. |
| JWT | Any valid user/admin JWT reaches the controller. |
| Admin JWT | The controller expects an admin record. |
| Super-admin | JWT plus a controller-level `super-admin` role check. |
| OAuth callback | Public provider redirect validated through stored OAuth state. |
| Signed webhook | Public receiver that validates the provider signature in its controller. |
| Unsigned webhook | Public receiver with no signature middleware in the current route. |

## System routes

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/` | Public | API welcome response. |
| GET | `/health/live` | Public | Process liveness, uptime, and timestamp. |
| GET | `/health/ready` | Public | MongoDB/Redis readiness; returns `503` until both are ready. |
| GET | `/uploads/<filename>` | Public | Serve locally stored uploads. |

## User authentication and profiles

Base path: `/api/auth`

| Method | Path | Access | Main input / purpose |
| --- | --- | --- | --- |
| POST | `/api/auth/register` | Public | JSON: `full_name`, `email`, `password`, `isAgree`; optional `phone`, `timeZone`, `country`. |
| POST | `/api/auth/login` | Public | JSON: `email`, `password`; returns a one-day JWT. |
| POST | `/api/auth/google-login` | Public | JSON: `tokenId` containing a Google ID token. |
| POST | `/api/auth/sendOtp` | Public | JSON: `email`; sends a password-reset OTP. |
| POST | `/api/auth/forgot-password` | Public | JSON: `email`, `otp`, `password`; completes user password reset. |
| GET | `/api/auth/user-profile` | JWT | Return the authenticated user without the password. |
| PUT | `/api/auth/update-profile` | JWT | Multipart or JSON profile fields; optional file field `image`. |
| GET | `/api/auth/get-all-user` | JWT | Admin-intended user list. Query: `search`, `page`, `limit`, `country`. |
| DELETE | `/api/auth/:id` | JWT | Delete a user and detach their businesses. No role check is currently applied. |
| GET | `/api/auth/fetch-user-location` | Public | Query: `lat`, `lon`; falls back to request-IP geolocation. |
| POST | `/api/auth/fetch-coordinates` | Public | JSON: `address`; forward-geocode an address. |
| GET | `/api/auth/export-users-excel` | Public | Download all users/businesses as an XLSX file. |

Example:

```sh
curl -X POST http://localhost:5000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com","password":"secret"}'
```

## Admin authentication and management

Base path: `/admin`

| Method | Path | Access | Main input / purpose |
| --- | --- | --- | --- |
| POST | `/admin/login` | Public | JSON: `email`, `password`; validates credentials and sends an OTP. |
| POST | `/admin/verify-otp` | Public | JSON: `email`, `otp`; returns the admin JWT. |
| POST | `/admin/register` | Public | JSON: `name`, `email`, `password`; creates a super-admin. |
| POST | `/admin/forgot-password` | Public | JSON: `email`; sends an admin reset OTP. |
| POST | `/admin/reset-password` | Public | JSON: `email`, `otp`, `newPassword`. |
| GET | `/admin/profile` | Admin JWT | Return the current admin profile and permissions. |
| PUT | `/admin/update-profile` | Admin JWT | JSON: optional `name`, `email`, `password`. |
| GET | `/admin/getalluserAndseller` | JWT | Return total user and seller counts. |
| POST | `/admin/create-subadmin` | Super-admin | JSON: `name`, `email`, `password`, optional `permissions`. |
| GET | `/admin/all-admins` | Super-admin | List sub-admin accounts. |
| PUT | `/admin/update-subadmin/:id` | Super-admin | JSON: optional `name`, `email`, `password`, `permissions`. |
| DELETE | `/admin/delete-subadmin/:id` | Super-admin | Delete a sub-admin. |
| PUT | `/admin/update-footer` | JWT | Replace footer-link content. |
| GET | `/admin/crm/analytics` | JWT | Global CRM analytics. Query: `startDate`, `endDate`. |
| GET | `/admin/crm/audit` | JWT | Global CRM audit. Query: `page`, `limit`, `action`, `search`. |

## Categories

Base path: `/api/category`. All routes in this router are currently public, including writes and maintenance operations.

| Method | Path | Main input / purpose |
| --- | --- | --- |
| GET | `/api/category/sample-csv` | Download the category import template. |
| POST | `/api/category/import-csv` | Multipart field `csvFile`; import categories. |
| GET | `/api/category/category-with-top` | Return categories and top-banner categories. |
| GET | `/api/category/categories` | Return all categories. |
| GET | `/api/category/categories-paginated` | Query: `page`, `limit`, `search`. |
| GET | `/api/category/autocomplete` | Query: `query`; autocomplete categories. |
| POST | `/api/category/categories` | Multipart: `name`, optional `description`, required `icon`, optional `bgImage`. |
| GET | `/api/category/:categoryId` | Return a category by MongoDB ID. |
| PUT | `/api/category/:categoryId` | Multipart update; optional `icon` and `bgImage`. |
| DELETE | `/api/category/:id` | Delete a category. |

## Subcategories

Base path: `/api/subCategory`. All routes in this router are currently public.

| Method | Path | Main input / purpose |
| --- | --- | --- |
| GET | `/api/subCategory/repair-slugs` | Repair stored subcategory slugs. This is a mutating maintenance action. |
| GET | `/api/subCategory/clean-duplicates` | Remove duplicate subcategories. This is a mutating maintenance action. |
| GET | `/api/subCategory/sample-subcategory-csv` | Download the import template. |
| POST | `/api/subCategory/import-subcategory-csv` | Multipart field `csvFile`. |
| POST | `/api/subCategory/subcategories` | Multipart: `name`, `category`, optional `description`, required `icon`. |
| GET | `/api/subCategory/subcategories` | Return all subcategories. |
| GET | `/api/subCategory/subcategories-paginated` | Query: `page`, `limit`, `search`. |
| GET | `/api/subCategory/subcategories/:categoryId` | Return subcategories for one category. |
| POST | `/api/subCategory/subcategories/by-categories` | JSON: `categoryIds` array. |
| PUT | `/api/subCategory/subcategories/:id` | Multipart subcategory update; optional `icon`. |
| DELETE | `/api/subCategory/:subCategoryId` | Delete a subcategory. |
| GET | `/api/subCategory/popular-searches` | Return popular-search subcategories. |

## Homepage and catalog content

### Banners

| Method | Path | Access | Main input / purpose |
| --- | --- | --- | --- |
| GET | `/api/banner/banners` | Public | Return active banners. |
| POST | `/api/banner/banners` | JWT | Multipart: required `title` and `image`; optional `bgImage`, `link`, `priority`, `isActive`. |
| PUT | `/api/banner/banners/:id` | JWT | Multipart banner update; image fields are optional. |
| DELETE | `/api/banner/banners/:id` | JWT | Delete a banner. |

### Top-banner categories

| Method | Path | Access | Main input / purpose |
| --- | --- | --- | --- |
| GET | `/api/top-banner-category` | Public | Return active top-banner categories. |
| POST | `/api/top-banner-category` | JWT | Multipart: `categoryId`, `image`; optional `title`, `paragraph`, `bgColor`, `priority`. |
| PUT | `/api/top-banner-category/:id` | JWT | Multipart update; optional `image`. |
| DELETE | `/api/top-banner-category/:id` | JWT | Delete an item. |

### Top countries

| Method | Path | Access | Main input / purpose |
| --- | --- | --- | --- |
| GET | `/api/top-country` | Public | Query: `search`, `page`, `limit`; list top countries. |
| GET | `/api/top-country/name/:name` | Public | Return one country by name. |
| POST | `/api/top-country` | JWT | Multipart country content; fields include `icon`, `galleryImages`, and indexed place/restaurant/hotel image fields. |
| PUT | `/api/top-country/:id` | JWT | Multipart country update. |
| DELETE | `/api/top-country/:id` | JWT | Delete a country. |

### Verticals, top services, free listings, and home

| Method | Path | Access | Main input / purpose |
| --- | --- | --- | --- |
| GET | `/api/verticals` | Public | List verticals. |
| POST | `/api/verticals` | Public | JSON: `title`, `description`; create a vertical. |
| GET | `/api/verticals/:title` | Public | Return a vertical by title. |
| PUT | `/api/verticals/:title` | Public | Update a vertical. |
| DELETE | `/api/verticals/:title` | Public | Delete a vertical. |
| GET | `/api/top-services` | Public | List top services. |
| POST | `/api/top-services` | Public | Multipart field `icon` plus service fields. |
| GET | `/api/freelisting` | Public | Return free-listing content. |
| POST | `/api/freelisting` | Public | Multipart field `icon` plus free-listing fields. |
| GET | `/api/home/popular-searches` | Public | Homepage popular-search data. |
| GET | `/api/home/featured-listings` | Public | Homepage featured businesses. |

### Popular searches

| Method | Path | Access | Main input / purpose |
| --- | --- | --- | --- |
| GET | `/api/popular-search` | Public | List popular searches. |
| POST | `/api/popular-search` | JWT | Multipart: `title`, `categoryId`, optional `priority`, `isActive`, `image`. |
| PUT | `/api/popular-search/:id` | JWT | Multipart update; optional `image`. |
| DELETE | `/api/popular-search/:id` | JWT | Delete a popular search. |

## Plans and pricing

### Legacy plans

All legacy plan routes are currently public.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/plan/plansAdd` | Create a plan. |
| GET | `/api/plan/plans` | List plans. |
| PUT | `/api/plan/:id` | Update a plan. |
| DELETE | `/api/plan/:id` | Delete a plan. |

### Pricing packages

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/api/pricing` | Public | List pricing packages. |
| GET | `/api/pricing/:id` | Public | Return a package by ID. |
| POST | `/api/pricing` | JWT | Create a package from JSON. |
| PUT | `/api/pricing/:id` | JWT | Update a package. |
| DELETE | `/api/pricing/:id` | JWT | Delete a package. |
| PATCH | `/api/pricing/:id/toggle` | JWT | Toggle active status. |
| POST | `/api/pricing/upload-feature-icon` | JWT | Multipart field `icon`; returns an uploaded icon URL. |

## Blogs and SEO

### Blogs

| Method | Path | Access | Main input / purpose |
| --- | --- | --- | --- |
| GET | `/api/blog?page=1` | Public | List published blogs, 12 per page. |
| GET | `/api/blog/:slug` | Public | Return a published blog by slug. |
| POST | `/api/blog` | JWT | Multipart: required `title`, `content`, `excerpt`, `featuredImage`; optional author, category, tags, SEO, FAQ, related-blog, and publish fields. |
| PUT | `/api/blog/:id` | JWT | Multipart blog update; optional `featuredImage`. |
| DELETE | `/api/blog/:id` | JWT | Delete a blog. |

### SEO

| Method | Path | Access | Main input / purpose |
| --- | --- | --- | --- |
| GET | `/api/seo/static` | JWT | List all configured static pages. |
| GET | `/api/seo/static/:pageKey` | Public | Return SEO for a static page. |
| PUT | `/api/seo/static/:pageKey` | JWT | Multipart SEO update; optional `bannerImage`. |
| GET | `/api/seo/business` | JWT | Search/paginate businesses for SEO management. |
| GET | `/api/seo/business/:id` | Public | Return one business's SEO data. |
| PUT | `/api/seo/business/:id` | JWT | Update business SEO fields. |

## Businesses, offers, and imports

Base path: `/api/business`

| Method | Path | Access | Main input / purpose |
| --- | --- | --- | --- |
| GET | `/api/business/autocomplete` | Public | Business autocomplete; query text and location filters. |
| POST | `/api/business/businesses` | JWT | Multipart business create; file fields `businessLogo` and up to five `photos`. |
| GET | `/api/business/distinct-countries` | Public | List countries represented by businesses. |
| GET | `/api/business/all-business` | Public | Admin-style complete business list. |
| PUT | `/api/business/update-business` | JWT | Multipart update for the authenticated owner's business. |
| PUT | `/api/business/kyc-update` | JWT | Multipart field `kycDocuments`, maximum 10 files. |
| DELETE | `/api/business/kyc-delete-document/:id` | JWT | Delete one KYC document. |
| PATCH | `/api/business/update-status/:id` | JWT | Update business status; optional multipart field `video`. |
| POST | `/api/business/update-social-info/:businessId` | JWT | Update social/profile data; optional `video`. |
| GET | `/api/business/profile-completion-score/:businessId` | JWT | Calculate profile completion. |
| PUT | `/api/business/update-contact-details/:id` | JWT | Update contact details from JSON. |
| GET | `/api/business/get-offers/:id` | JWT | List offers for a business. |
| POST | `/api/business/create-offer` | JWT | Create an offer from JSON. |
| DELETE | `/api/business/delete-offer/:offerId` | JWT | Delete an offer. |
| GET | `/api/business/businesses` | Public | Search/list published businesses. |
| GET | `/api/business/businessById/:id` | Public | Return one business. |
| GET | `/api/business/user-business` | JWT | Return businesses owned by the current user. |
| GET | `/api/business/search` | Public | Search services/businesses using query filters. |
| PATCH | `/api/business/block/:businessId` | Public | Block/unblock a business. Currently has no auth middleware. |
| DELETE | `/api/business/delete/:businessId` | Public | Delete a business. Currently has no auth middleware. |
| POST | `/api/business/check-phone` | Public | JSON phone lookup. |
| POST | `/api/business/import` | JWT | Multipart `file` or legacy `csvFile`; accepts one CSV/XLSX file. |
| POST | `/api/business/import-csv` | JWT | Alias of `/api/business/import`. |
| GET | `/api/business/import-batches/:batchId` | JWT | Query `page`, `limit`; return batch and row results. |
| GET | `/api/business/import-batches/:batchId/rows` | JWT | Alias returning the same paginated batch result. |
| POST | `/api/business/sync-geocoding` | JWT | Queue businesses with missing coordinates for geocoding. |
| GET | `/api/business/download-sample-csv` | Public | Download sample CSV. |
| GET | `/api/business/download-sample-excel` | Public | Download sample XLSX. |

Business imports require `Business Name` and `Phone`. Optional columns are `Email`, `Address`, `Website`, `Rating`, `Reviews`, `Latitude`, `Longitude`, `Category`, `Subcategory`, and `Country`.

```sh
curl -X POST http://localhost:5000/api/business/import \
  -H 'Authorization: Bearer <jwt>' \
  -F 'file=@businesses.xlsx'
```

## Reviews, appointments, claims, enquiries, and questions

### Reviews

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| POST | `/api/review/reviews` | JWT | Create a business review. |
| GET | `/api/review/reviews/:businessId` | Public | List reviews for a business. |
| POST | `/api/review/all-business-reviews` | Public | Return reviews for a supplied business set/filter. |

### Appointments

All appointment routes require JWT authentication.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/appointment` | Create an appointment. |
| GET | `/api/appointment` | List the authenticated user's appointments. |
| GET | `/api/appointment/business/:businessId` | List appointments for a business. |
| GET | `/api/all-appointments` | Return all appointments. |
| PUT | `/api/appointment/:appointmentId` | Reschedule using `appointmentDate` and `timeSlot`. |
| PATCH | `/api/appointment/:appointmentId` | Cancel an appointment. |

### Claims

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/api/claims/my-claims` | JWT | Return the current user's claims. |
| POST | `/api/claims/:businessId` | JWT | Multipart claim; fields `businessData`, `businessLogo`, up to five `photos`, and `kycDocuments`. |
| GET | `/api/claims` | JWT | List claims. |
| GET | `/api/claims/:claimId` | JWT | Return one claim. |
| PUT | `/api/claims/:claimId/status` | JWT | JSON: `status`; update claim status. |
| POST | `/api/sync-approved-claims` | Public | Synchronize approved claims. Currently has no auth middleware. |

### Enquiries

All enquiry routes are currently public, including admin-intended operations.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/enquiry` | Create an enquiry. |
| GET | `/api/enquiry` | List all enquiries. |
| PUT | `/api/enquiry/:id` | Resolve/update an enquiry. |
| DELETE | `/api/enquiry/:id` | Delete an enquiry. |
| GET | `/api/enquiry/business/:businessId` | List enquiries for a business. |

### Questions

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| POST | `/api/question` | JWT | Create a question. |
| GET | `/api/question` | Public | List questions. |
| PUT | `/api/question/:id` | Public | Post/update the answer. |

## Notifications

The same router is mounted under three prefixes for compatibility:

```text
/api/notification
/notification
/message
```

Replace `{notificationBase}` below with any one of those prefixes. This means every row represents three callable path aliases.

| Method | Path suffix | Access | Purpose |
| --- | --- | --- | --- |
| GET | `{notificationBase}` | JWT | List current-recipient notifications. |
| GET | `{notificationBase}/notifications` | JWT | Legacy list alias. |
| GET | `{notificationBase}/counts` | JWT | Return unread totals grouped by category. |
| GET | `{notificationBase}/notification-counts` | JWT | Legacy count alias. |
| POST | `{notificationBase}/create-notification` | Public | JSON: `title`, `description`, optional `link`, `image`; notify every user. |
| PUT | `{notificationBase}/mark-read/:notificationId` | JWT | Mark one notification read. |
| PUT | `{notificationBase}/notifications/mark-read/:notificationId` | JWT | Legacy mark-read alias. |
| PUT | `{notificationBase}/mark-all-read` | JWT | Mark all current-recipient notifications read. |
| PUT | `{notificationBase}/notifications/mark-all-read` | JWT | Legacy mark-all alias. |
| DELETE | `{notificationBase}/:notificationId` | JWT | Delete a notification. |
| DELETE | `{notificationBase}/notifications/:notificationId` | JWT | Legacy delete alias. |

## Email templates and campaigns

These routes are mounted directly below `/api`, not below `/api/email-campaign`. All routes require JWT except the unsubscribe link.

### Templates and sender addresses

| Method | Path | Access | Main input / purpose |
| --- | --- | --- | --- |
| POST | `/api/templates` | JWT | JSON: required `name`, `subject`, `body`; optional preview, sender, reply-to, and custom-variable fields. |
| POST | `/api/templates/upload-image` | JWT | Multipart field `image`. |
| POST | `/api/templates/send-test` | JWT | Send a test using supplied template/content and recipient. |
| GET | `/api/templates` | JWT | List templates. |
| GET | `/api/templates/:id` | JWT | Return one template. |
| PUT | `/api/templates/:id` | JWT | Update a template. |
| DELETE | `/api/templates/:id` | JWT | Delete a template. |
| POST | `/api/sender-emails` | JWT | Add a sender email. |
| GET | `/api/sender-emails` | JWT | List sender emails. |
| PATCH | `/api/toggle-sender-email-status/:id` | JWT | Toggle sender status. |
| PATCH | `/api/sender-emails/:id` | JWT | Mark/update sender spam status. |

### Campaigns

| Method | Path | Access | Main input / purpose |
| --- | --- | --- | --- |
| POST | `/api/campaigns/attachments` | JWT | Multipart field `attachments`, maximum five files, 10 MB each. |
| POST | `/api/campaigns` | JWT | JSON or multipart campaign create; optional `attachments`. |
| POST | `/api/campaigns/process-excel` | JWT | Multipart field `file`; extract/deduplicate recipient emails from XLSX. |
| GET | `/api/campaigns/sample-excel` | JWT | Download a sample recipient XLSX. |
| GET | `/api/campaigns` | JWT | List campaigns. |
| GET | `/api/campaigns/:id` | JWT | Return one campaign. |
| PUT | `/api/campaigns/:id` | JWT | JSON or multipart update; optional `attachments`. |
| DELETE | `/api/campaigns/:id` | JWT | Delete a campaign. |
| PATCH | `/api/campaigns/:id/cancel` | JWT | Cancel a scheduled campaign. |
| POST | `/api/campaigns/:id/send` | JWT | Send/queue a campaign. |
| GET | `/api/users` | JWT | List users available to campaigns. |
| GET | `/api/unsubscribe` | Public | Email-campaign unsubscribe link handled by `emailCampaignController`. |

Allowed attachment types are PDF, DOC, DOCX, JPEG, PNG, and plain text.

## Subscription and payment APIs

Base path: `/api/subscription`

| Method | Path | Access | Main input / purpose |
| --- | --- | --- | --- |
| POST | `/api/subscription/create-paypal-subscription` | JWT | JSON: `businessId`, `packageId`; returns PayPal approval data. |
| POST | `/api/subscription/paypal-webhook` | Signed webhook | PayPal event receiver; verifies PayPal transmission headers. |
| POST | `/api/subscription/create-razorpay-subscription` | JWT | JSON: `businessId`, `packageId`; returns Razorpay subscription data. |
| POST | `/api/subscription/razorpay-webhook` | Signed webhook | Validates `X-Razorpay-Signature` against the raw body. |
| POST | `/api/subscription/verify-razorpay-subscription` | JWT | JSON: Razorpay payment/subscription IDs, signature, and `businessId`. |
| GET | `/api/subscription/business/:businessId` | JWT | Return a business subscription. |
| POST | `/api/subscription/cancel/:businessId` | JWT | Cancel a subscription. |
| POST | `/api/subscription/reactivate/:businessId` | JWT | Reactivate a subscription. |
| GET | `/api/subscription/admin/all` | JWT | Admin-intended list of every business subscription. |

## Social integrations

Tenant OAuth application credentials are stored encrypted per tenant. Supported configuration values are `facebook`, `instagram`, `linkedin`, `twitter`, `pinterest`, and `google_business` (`google` is normalized to `google_business` when saving/removing configuration).

### Tenant credentials and social account OAuth

Base path: `/api/social-integrations`

| Method | Path | Access | Main input / purpose |
| --- | --- | --- | --- |
| GET | `/api/social-integrations/config` | JWT | Return redacted configuration status for every provider. |
| PUT | `/api/social-integrations/config/:platform` | JWT | JSON: `clientId`, `clientSecret`, `redirectUri`; save encrypted tenant credentials. |
| DELETE | `/api/social-integrations/config/:platform` | JWT | Remove tenant credentials, OAuth state, and associated connections. |
| GET | `/api/social-integrations/auth-url` | JWT | Query: `platform`, optional `returnTo`; create a one-time OAuth URL. |
| GET | `/api/social-integrations/callback/:platform` | OAuth callback | Provider callback query: `code`, `state`, or provider `error`; redirects to frontend. |
| POST | `/api/social-integrations/connect` | JWT | Deprecated direct exchange; always returns `410 Gone`. |
| POST | `/api/social-integrations/disconnect` | JWT | JSON: `platform`; disconnect the current user's account. |
| GET | `/api/social-integrations/accounts` | JWT | Return redacted connection state for all social providers. |
| POST | `/api/social-integrations/refresh` | JWT | JSON: `platform`; refresh or validate the provider token. |
| POST | `/api/social-integrations/verify-post` | JWT | JSON: `platform`, `postData`; verify/publish through one provider. |

### Google Business Profile

Base path: `/api/google-business`. Google access is read-only; `populate-profile` writes only to this application's User/Business records.

| Method | Path | Access | Main input / purpose |
| --- | --- | --- | --- |
| GET | `/api/google-business/auth-url` | JWT | Optional query `returnTo`; create Google OAuth URL. |
| GET | `/api/google-business/callback` | OAuth callback | Query: `code`, `state`, or `error`; redirects to frontend. |
| POST | `/api/google-business/connect` | JWT | Deprecated direct exchange; returns `410 Gone`. |
| POST | `/api/google-business/disconnect` | JWT | Delete the current tenant/user Google connection. |
| GET | `/api/google-business/profiles` | JWT | List available accounts/locations. |
| POST | `/api/google-business/select-profile` | JWT | JSON: `locationName` or legacy `businessId`. |
| GET | `/api/google-business/selected-profile` | JWT | Return the cached/refreshed selected profile. |
| POST | `/api/google-business/populate-profile` | JWT | JSON: optional `target` (`user`, `business`, `both`) and `businessId`. |

### Social publishing and scheduling

Base path: `/api/social-posting`

| Method | Path | Access | Main input / purpose |
| --- | --- | --- | --- |
| POST | `/api/social-posting/publish` | JWT | JSON: `caption`, `media`, non-empty `platforms`, optional `platformOptions`. |
| GET | `/api/social-posting/history` | JWT | Query: `page`, `limit`. |
| POST | `/api/social-posting/schedule` | JWT | Publish fields plus required ISO `scheduledFor`. |
| GET | `/api/social-posting/scheduled` | JWT | Query: `page`, `limit`, `status`. |
| DELETE | `/api/social-posting/scheduled/:id` | JWT | Cancel an unprocessed scheduled post. |

Provider-specific publishing constraints are documented in `docs/social-integrations.md`.

## CRM APIs

CRM routes are owner-scoped by the authenticated principal in their current services. All routes require JWT unless explicitly labeled otherwise.

### Leads

Base path: `/api/crm/leads`

| Method | Path | Main input / purpose |
| --- | --- | --- |
| POST | `/api/crm/leads` | Create a lead from JSON. |
| GET | `/api/crm/leads` | List/paginate/filter leads. |
| PUT | `/api/crm/leads/kanban/reorder` | JSON: `updates` array; reorder/move Kanban leads. |
| GET | `/api/crm/leads/:id` | Return one owned lead. |
| PUT | `/api/crm/leads/:id` | Update an owned lead. |
| POST | `/api/crm/leads/:id/activities` | Add an activity entry. |
| DELETE | `/api/crm/leads/:id` | Delete a lead. |
| POST | `/api/crm/leads/import` | Multipart field `file`; CSV, XLSX, or XLS, default maximum 10 MB. |

### Contacts

Base path: `/api/crm/contacts`

| Method | Path | Main input / purpose |
| --- | --- | --- |
| POST | `/api/crm/contacts` | Create a contact. |
| GET | `/api/crm/contacts` | List/paginate/filter contacts. |
| POST | `/api/crm/contacts/bulk-delete` | JSON: `contactIds` array. |
| GET | `/api/crm/contacts/:id` | Return one owned contact. |
| PUT | `/api/crm/contacts/:id` | Update a contact. |
| DELETE | `/api/crm/contacts/:id` | Delete a contact. |
| POST | `/api/crm/contacts/:id/convert` | Convert a contact into a lead; accepts optional lead overrides. |

### Follow-up automation

Base path: `/api/crm/leads/followup`

| Method | Path | Main input / purpose |
| --- | --- | --- |
| GET | `/api/crm/leads/followup/config` | Return the owner's follow-up configuration. |
| PUT | `/api/crm/leads/followup/config` | Update cadence/template/limit configuration. |
| GET | `/api/crm/leads/followup/logs` | Paginated follow-up logs and filters. |
| POST | `/api/crm/leads/followup/process` | Trigger a follow-up processing sweep. |
| POST | `/api/crm/leads/followup/retry` | Retry a failed follow-up from request data. |
| POST | `/api/crm/leads/followup/:id/trigger` | Trigger follow-up for one lead. |

### Replies

Base path: `/api/crm/leads/replies`

| Method | Path | Access | Main input / purpose |
| --- | --- | --- | --- |
| POST | `/api/crm/leads/replies/reply-webhook` | Unsigned webhook | JSON: `body` or `text`, plus `leadId` or `fromEmail`/`from`; optional `ownerId`, `subject`. |
| GET | `/api/crm/leads/replies/logs` | JWT | List reply-classification logs with pagination/filter query fields. |
| POST | `/api/crm/leads/replies/:id/reply` | JWT | JSON: required `body`; optional `subject`, `fromEmail`. |

### Forecast, dashboard, calendar, audit, and configuration

| Method | Path | Access | Main input / purpose |
| --- | --- | --- | --- |
| GET | `/api/crm/forecast` | JWT | Weighted revenue forecast; accepts service filter/date query fields. |
| GET | `/api/crm/dashboard/summary` | JWT | CRM dashboard summary. |
| GET | `/api/crm/calendar/events` | JWT | Query/filter calendar events. |
| POST | `/api/crm/calendar/events` | JWT | Create an event. |
| PUT | `/api/crm/calendar/events/:id` | JWT | Update an event. |
| DELETE | `/api/crm/calendar/events/:id` | JWT | Delete an event. |
| GET | `/api/crm/audit` | JWT | Query/paginate owner audit logs. |
| GET | `/api/crm/audit/export` | JWT | Export filtered audit logs as CSV. |
| GET | `/api/crm/audit/:leadId` | JWT | Return audit logs for one lead. |
| GET | `/api/crm/config/stages` | JWT | Return pipeline stages. |
| PUT | `/api/crm/config/stages` | JWT | Replace/update pipeline stages and probabilities. |
| GET | `/api/crm/config/event-types` | JWT | Return configured CRM event types. |
| GET | `/api/crm/config/reply-keywords` | JWT | Return reply-classification keywords. |
| GET | `/api/crm/config/scheduler` | JWT | Return scheduler configuration. |

## Unsubscribe API

| Method | Path | Access | Main input / purpose |
| --- | --- | --- | --- |
| GET | `/api/unsubscribe` | Public | Email link endpoint. Query values are handled by `emailCampaignController` because that route is mounted first. |
| POST | `/api/unsubscribe` | Public | JSON or query: `email` or `userId`; optional `reason`, `source`. |
| GET | `/api/unsubscribe/check` | Public | Query: `email`; return subscription status. |

`POST /api/unsubscribe` can receive the same values in the query string. The generic unsubscribe controller can return HTML when `format=html` or the request accepts HTML.

## Current exposure and route caveats

This section records the implemented route state; it is not a recommendation to expose these operations publicly.

- Admin-intended but currently public operations include `/admin/register`, `/api/auth/export-users-excel`, category/subcategory writes and maintenance routes, plan writes, vertical writes, free-listing/top-service creation, enquiry administration, question replies, business block/delete, approved-claim synchronization, and global notification creation.
- Most JWT routes do not check a role or permission. Only the sub-admin management controllers explicitly enforce `super-admin`.
- `POST /api/crm/leads/replies/reply-webhook` is rate-limited in production but does not mount `webhookAuth`; it is currently unsigned.
- PayPal and Razorpay webhook controllers do perform provider-signature verification.
- `routes/footerRoutes.js` defines `GET /footer-links`, but `server.js` does not mount that router. The endpoint currently returns `404`; only `PUT /admin/update-footer` is reachable.
- `server.js` prepares/rate-limits `/api/email-campaign/delivery-webhook`, but no route handler is mounted at that path.
- `getAdminBlogs` and `insertManyVerticals` controller functions exist but have no mounted routes.
- `GET /api/unsubscribe` is declared twice; the email-campaign handler is mounted first and shadows the generic GET handler.

## Rate limiting

Rate limiting is enabled when `NODE_ENV=production` or `ENABLE_RATE_LIMITING=true`:

- `/api/auth` receives both the auth limiter and the general `/api` limiter.
- `/api/crm/leads/replies/reply-webhook` receives both the webhook limiter and the general `/api` limiter.
- all `/api/*` routes receive the general API limiter.
- `/admin`, `/notification`, and `/message` paths are not covered by the general `/api` limiter.

See `.env.example` and `.env.observability.example` for runtime configuration.
