# Per-user social integrations

This is a tenant-scoped Bring Your Own App integration. Each tenant stores its own encrypted provider client ID, client secret, and redirect URI in `TenantSocialCredential`. Every OAuth transaction is tied to both tenant and authenticated user through a one-time, expiring, hashed state record. Twitter/X additionally uses PKCE. Provider tokens are encrypted with `ENCRYPTION_KEY`, stored in `SocialConnection` or `GoogleBusinessConnection`, excluded by default from Mongoose queries, and never returned by the API.

## Provider boundaries

- Facebook connects the user and discovers the Pages they can manage. Publishing supports Page feed, photo, and hosted-video URL posts and requires the user-selected Page ID and its Page access token; personal Facebook profile publishing is not implemented because the official Graph API does not provide that workflow.
- Instagram uses Instagram Login for professional accounts and the official media-container then publish workflow. Media must be publicly reachable by Instagram. The official long-lived token exchange and refresh endpoints are used.
- Threads uses its separate Threads App ID and App Secret, `threads_basic` plus `threads_content_publish`, the container/publish workflow, and long-lived Threads token refresh. Threads credentials are not interchangeable with the parent Meta App Secret.
- LinkedIn uses 3-legged OAuth, `openid profile email w_member_social`, `/v2/userinfo`, and the versioned REST Posts API. The current publisher is text-only and rejects media instead of silently dropping it. Programmatic refresh is used only when the application is approved for it; otherwise the user must reconnect.
- Twitter/X uses OAuth 2 authorization-code + PKCE with `offline.access`. The current publisher supports text-only posts. Media upload is intentionally rejected until the project implements the platform's separate official media-upload authorization workflow.
- Pinterest uses OAuth 2, user-selected boards, `/v5/pins`, and continuous refresh tokens for eligible applications. A board ID and public image URL are required for a Pin.
- Google Business Profile is provider-read-only. Google offers the single `business.manage` scope rather than a narrower read-only scope, so UC enforces read-only behavior by issuing only GET requests. Account and location pagination is followed completely, duplicate locations exposed through multiple accessible accounts are collapsed by Google's location resource name, and location reads use a field mask including `metadata,openInfo` for the Maps link and open status. Local import writes only to UC. Media (logo/photos) is read, best-effort, from the v4 `.../media` list endpoint under the same scope; a failure there never blocks the rest of an import.

### Importing a Google Business Profile as a new UC Business

`POST /api/google-business/import-location` is the one supported path for turning a Google Business Profile location into a UC Business — it is a thin controller over `services/googleBusinessImportService.js`, which itself calls the same `services/businessService.js#createBusiness` the manual "Create Business" form uses, so an imported business is a normal Business record with no separate "Google Business" model. The service:

- Re-fetches the requested location with the caller's own Google token (never trusts client-supplied profile data), so a location the caller cannot manage in Google fails with `403` before any database write.
- Looks for an existing Business already linked by `googleLocationId` (Google's durable identifier, preferred over name matching). A manual listing is linked by name only when exactly one same-owner candidate is also corroborated by phone, city plus postal code, or near-identical coordinates; name alone is intentionally insufficient. If the Google ID belongs to another UC owner, the API returns `409` with `existingBusinessId` rather than duplicating or transferring it; the frontend offers the existing claim flow (`/claim-business/:businessId`). A partial unique database index over non-empty Google IDs is the final concurrent-request guard.
- Maps Google's `regularHours.periods` into UC's per-day `businessTiming` shape (including the 24-hour-day case), converts the location's ISO region code into UC's canonical country name, and carries over description, website, additional categories/phones, and the Google Maps link.
- Requires a UC `Category` — either passed by the caller (chosen on the frontend's review step) or matched by exact name against Google's primary category; it does not auto-create categories.
- Falls back to this codebase's existing "unknown" import sentinels (`Unknown City` / `Unknown State` / `000000` / `Unknown Country`, the same ones `services/businessImportService.js`'s CSV/XLSX import already uses) only for the handful of address fields the Business schema requires but Google did not supply — it never invents a phone number, coordinates, or any other realistic-looking value. Missing coordinates instead set `needsGeocoding: true`, which queues the same `geocoding-batch` job the CSV import path uses.

### Mapping and synchronization behavior

| Google field | UC Business field | Refresh behavior |
| --- | --- | --- |
| Location resource name | `googleLocationId` | Stable link and unique duplicate key |
| Title | `businessName` | Refreshed for Google-imported listings |
| Primary category display name | `importedCategory`; user-selected/matched UC `category` | Display name refreshes; UC category is not silently remapped |
| Additional category display names | `servicesTypes` | Refreshed for Google-imported listings |
| Storefront address and lat/lng | `address`, `location`, `needsGeocoding` | Refreshed when representable |
| Primary/additional phones | `contact.mobile` and the imported owner contact | Refreshed for Google-imported listings |
| Website/profile description | `website`, `description` | Refreshed for Google-imported listings |
| Regular hours | `businessTiming` | Refreshed; 24-hour periods map to `00:00`–`23:59` |
| Maps URI | `socialLinks.googleMaps` | Filled when absent |
| Profile media | `businessLogo`, `photos` | Best-effort refresh when the media endpoint succeeds |

`creationSource=google_business` means the listing was created from Google and its provider-owned fields are refreshed. A manual listing linked later remains `creationSource=manual`; refresh fills missing/default values without overwriting the owner's existing content. Every successful link/refresh updates `googleLastSyncedAt`. Refresh is user-triggered only—there is no existing Google webhook, Pub/Sub consumer, or scheduled profile-sync worker to reuse.

UC cannot currently represent Google service areas, special/more hours, arbitrary attributes, services, or open-status history in the `Business` schema, so those are not persisted. Google does not return private owner email addresses as location contact data. UC also does not copy reviews/ratings through this location-information flow. Provider access requires Google project approval and has no sandbox; media remains best-effort because it is served by a separate v4 endpoint.

Before deploying the unique Google-location constraint to a database that already contains businesses, run `npm run indexes`. The existing index script audits duplicate non-empty `googleLocationId` values and stops for human review rather than deleting or reassigning business data. After conflicts are resolved, rerunning replaces the old non-unique index with the partial unique index and verifies the remaining Business indexes.

`GET /api/google-business/profiles` is read-only: it lists every paginated location the caller can access, each annotated with `linkedBusinessId` / `linkedToCurrentUser` (for the frontend to show "Already imported" / "Linked to another account") and a `suggestedCategoryId`, but it no longer creates or modifies any Business record (a prior version auto-imported every listed location on every call). `POST /api/google-business/populate-profile`'s `business` target now only enriches an existing, ownership-scoped business through the same sync logic described above; it no longer has its own, separate business-creation code path.

## Media hosting

Every provider downloads attached media from the URL the post carries, so the URL must be a public `http(s)` address. `POST /api/social-posting/upload-media` (multipart field `media`, image or video, 50 MB max) stores the file on Cloudinary under `social-posts/<tenantId>/` and returns `{ url, type }`; the frontend "Upload File" mode calls it and forwards the returned URL to `/publish` and `/schedule`. Images are normalised to JPEG because Instagram only accepts JPEG by URL. `publishUnifiedPost` and `scheduleUnifiedPost` reject `blob:`, `data:`, and localhost URLs up front, since those produce misleading provider errors ("Unsupported state or unable to authenticate data" on Facebook, "Only photo or video can be accepted as media type" on Instagram). Cloudinary credentials (`CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`) must be configured for uploads to work.

## Credential setup

Credentials must be entered through `/settings/integrations`. They are encrypted into `TenantSocialCredential`; provider secrets must not be placed in `.env` or frontend variables. The UI displays the exact backend callback URI that must be registered for each provider.

X requires the OAuth 2.0 Client ID and Client Secret from User authentication settings. Consumer API keys and an app-only bearer token cannot authorize user posting. Google Business Profile needs a Web application OAuth client whose callback ends in `/api/google-business/callback`; the portal Google Sign-In client is separately configured through `GOOGLE_CLIENT_ID` and `VITE_GOOGLE_CLIENT_ID`.

Scheduling is application-side via BullMQ. The provider APIs are not treated as supporting native scheduling; each scheduled job publishes through the user's own connection when it runs. A 429/5xx response is retried with bounded exponential backoff, and each platform result is recorded independently.
