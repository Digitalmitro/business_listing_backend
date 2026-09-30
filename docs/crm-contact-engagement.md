# CRM contacts and AI email engagement

Contacts are the people a business can talk to: visitors who left their email on the listing, customers who booked, enquirers, leads, and contacts imported in bulk. Every contact belongs to one Business, like the rest of the business-wise CRM. The engagement system watches what contacts do, starts the right email journey, personalises it, spaces the emails out, and stops or hands over when the contact books, replies, converts or opts out.

It builds on the existing CRM email automation (`docs/crm-email-automation.md`). Journey emails are `CrmEmailDispatch` rows with `trigger: "journey"`, so they share its queue, atomic claim, retries, delivery log and worker sweep.

```
activity ─► crmSignalService.emit ─► contact found/created ─► activity timeline
                                   └► crmJourneyService.handleSignal
                                        ├─ exit journeys that stop on this signal (booking → "converted")
                                        └─ enrol in the best enabled journey for this signal
enrolment ─► (wait) ─► advanceEnrollment: condition, consent, frequency cap, send window, import pacing
          ─► CrmEmailDispatch (trigger "journey") ─► processDispatch ─► processJourneyDispatch
          ─► render + tracked links + signed unsubscribe ─► send ─► next step / completed / exited
```

## Where it lives in the UI

Customer CRM suite (`/crm-suite?businessId=…`):

- **CRM Contacts**: contact list with engagement filters, bulk actions, a contact profile (timeline, viewed items, bookings, journeys, emails, email preferences), **Import contacts**, and **Sync from leads & bookings**.
- **AI Engagement**: overview and settings, journeys (with **Plan with AI**), template library, active journeys, and email history.
- **Email Automation** (existing): transactional lead and booking emails. The booking emails there are the "booking communication flow" that journeys hand over to.

Listing page: a **Get updates** email box (the capture widget) and activity tracking (listing viewed, service viewed, booking page opened).

## Signals

`services/crmEngagementCatalog.js` `SIGNALS` is the registry. To add a trigger, add a signal there and call the signal service where the event happens. Journeys are data, so the journey engine needs no changes.

| Signal | Emitted by | Starts journeys | Notes |
| --- | --- | --- | --- |
| `contact_captured` | public capture endpoint | yes | Explicit opt-in on the listing page. |
| `business_viewed`, `service_viewed` | `/public/track`, listing page | yes | Known contacts only (see privacy). Views of the same item within 30 minutes are folded together. |
| `repeat_visit` | after every view | yes | `minVisits` within `withinDays` (defaults 3 in 7 days). |
| `booking_started` | booking page | no | Stored as `bookings.lastStartedAt`. |
| `booking_abandoned` | sweep (derived) | yes | Started, not booked after `afterHours` (default 2h); looks back at most 3 days. |
| `booking_created` | `POST /api/appointment`, reschedule | yes | Conversion: exits marketing journeys as **converted**. Transactional booking emails continue. |
| `booking_canceled` | cancel | yes | |
| `enquiry_submitted` | profile enquiry | yes | Only when the enquirer is signed in (enquiries have no email) or already a contact. |
| `contact_imported` | import triage | yes | Only used through triage, never fired for every row. |
| `inactive` | sweep (derived) | yes | No activity for `inactiveDays` (default 60). Each contact is checked at most weekly. |
| `email_clicked` | tracked link redirect | no | First click per email. |
| `email_replied` | reply tracking | no | Conversion. |
| `lead_won` | lead moved to Closed Won/Completed | no | Conversion. |
| `unsubscribed` | signed link, owner action, global unsubscribe | no | Always stops every journey. |

## Journeys

A `CrmJourney` has:

- `trigger`: `{ signal, params }`
- `steps`: up to 6. Each step has a `templateId`, a `delay` (`{ amount, unit }`, measured from enrolment for the first step and from the previous email after that; follow-ups must wait at least 1 hour, and no step can wait more than 60 days) and a `condition`:
  - `always`
  - `no_click`: only if they haven't clicked since the last email
  - `not_booked`: only if they still haven't booked
- `exitOn`: signals that stop the journey. Unsubscribes and bounces always stop it.
- `priority`
- `reentryDays`
- `isEnabled`

Rules:

- **One active journey per contact per business.** A higher-priority journey replaces a lower one. An equal or lower one is skipped.
- A contact does not re-enter the same journey within `reentryDays`.
- A journey can only be switched on when every template in it is approved. Editing a template clears its approval and switches off every journey that uses it.
- Switching a journey (or all engagement) off pauses its contacts. They resume when it is switched back on.

Five starter journeys are copied, switched off, into each business the first time the engagement tab (or template or journey list) is opened:

- Recently viewed follow-up
- Repeat visitor
- Complete your booking
- Win back inactive contacts
- Introduce yourself to imported contacts

## Templates

`CrmEngagementTemplate` holds one business's library. It starts with seven starter templates:

- You recently viewed…
- Still interested?
- Can we help you find what you're looking for?
- Complete your booking
- We noticed you were interested…
- It's been a while — come back and explore
- Hello from us (introduction)

Owners can edit, duplicate, create, archive and preview templates, and ask AI to draft, rewrite or improve one.

Variables: `{{name}}` (first name, or "there"), `{{business_name}}`, `{{service_name}}`, `{{viewed_item}}`, `{{viewed_items}}` (up to 3), `{{booking_date}}`, `{{booking_time}}`, `{{booking_link}}` (the booking page, or the customer's bookings when they have an upcoming one) and `{{listing_url}}`. Validation, sanitising and escaping are shared with email automation (`crmEmailAutomationCatalog`).

Only public or recipient-owned facts are ever inserted: their name, what they viewed on this business, and their own booking. Notes, tags, lead status and other internal CRM data are never available to templates.

## Sending rules

At send time, a journey email is sent only when all of these are true:

- the business switched engagement on
- the journey is enabled
- the template is approved
- the contact has a valid email and is `subscribed`
- the contact has a marketing consent basis (`opt_in`, `customer`, `lead`, `import_confirmed` or `manual_confirmed`). `unknown`, which covers legacy and manually added contacts until the owner confirms, is never emailed
- the address is not in `UnsubscribedEmail` and its user has not turned off `subscribedToEmails`

Frequency and timing:

- **Per business:** at most `maxPerWeek` marketing emails (default 2) and at least `minHoursBetween` hours apart (default 48). This counts journey emails and `lead_viewed` automation emails.
- **Platform-wide:** at most `CRM_ENGAGEMENT_GLOBAL_DAILY_CAP` (default 3) marketing emails to one address per 24 hours, across all businesses.
- **Send window:** 9:00 to 20:00 in the business's timezone by default. The default timezone is the owner's.
- **Imports:** first emails to imported contacts are paced to `importDailyLimit` per day (default 200).

A blocked step is deferred, not dropped.

Each email includes:

- tracked links (signed redirect, first click recorded)
- a signed, per-business unsubscribe link
- RFC 8058 one-click `List-Unsubscribe` headers
- a "you're receiving this because…" line

The Reply-To is the owner's email.

A hard SMTP bounce (550, 551 or 553, or a 5.1.x response) marks the contact `bounced` and ends its journey.

## Bulk import

1. `POST /imports` (multipart `file`, `businessId`)
   - Stores the file in `storage/imports`, which is private and never under `/public`.
   - Maps columns by header synonyms first. When `ANTHROPIC_API_KEY` is set, AI fills in any unmapped headers; only header names are sent, never cell values.
   - Returns the headers, 5 preview rows and a dry run: valid contacts, invalid rows, duplicates in the file, matches with existing contacts, and how many rows have an email.
2. `POST /imports/:id/validate`: dry run for an edited mapping.
3. `POST /imports/:id/commit` with `{ mapping, options }`:
   - `duplicateMode`:
     - `fill_empty` (default): only fills empty fields
     - `overwrite`: replaces fields with the file's non-empty values
     - `skip`: leaves existing contacts alone
     - In every mode, tags are added and notes appended. Activity, engagement, bookings and opt-outs are never lost, and an import never re-subscribes anyone.
   - `tags`
   - `consentConfirmed`: the owner confirms these people agreed to hear from them. Without it, imported contacts are stored but never emailed.
   - `engagement`: `auto` or `none`

Opt-outs in the file (for example a *Subscribed* column set to "no") are honoured in every mode.

The response includes a summary: created, updated, unchanged, invalid, duplicates in the file, and suppressed. It also includes row errors; `GET /imports/:id/errors.csv` downloads them.

After a commit with consent and `engagement: auto`, new contacts are **triaged**:

- They are grouped into anonymous segments by last activity (for example, 91–365 days ago), relationship (customer, open lead, lost lead) and first tag.
- Each segment enters one of the enabled `contact_imported` (intro) or `inactive` (win-back) journeys, or waits.
- With AI, Claude decides per segment, seeing only segment descriptions and counts. Without AI, the rules are:
  - lost leads wait
  - recent customers wait
  - recently active contacts get the intro journey
  - contacts quiet for 3 months or more get win-back
  - contacts with unknown history get the intro journey
- If no suitable journey is switched on, or engagement is off, everyone waits. The owner can press **Review again** later (`POST /imports/:id/retriage`).

The triage outcome per segment is shown in import history. `triage.status` goes `pending` → `running` (a 15-minute lease, so the API process and the worker sweep never both run it) → `done`. If a run fails it returns to `pending` with `triage.error` set, and the next sweep retries it.

## AI

All AI calls go through `crmEmailAiService.callStructured`: `claude-opus-5` (`CRM_AI_EMAIL_MODEL`), JSON-schema output, and `fallbacks: "default"`. The API key stays on the server. AI endpoints share the `aiLimiter`.

| Feature | Endpoint | Sends to the model | Saves? |
| --- | --- | --- | --- |
| Draft, rewrite or improve a template | `POST /ai/template` | Public business info, the owner's instruction and draft | No, returns a draft |
| Plan journeys | `POST /ai/plan` | Public business info, template names and subjects, journey names | No. `POST /ai/plan/apply` creates switched-off journeys and unapproved templates |
| Import triage | automatic | Segment descriptions and counts, enabled journey names | Enrols contacts (approved content only) |
| Column mapping | automatic on upload | Header names only | No |

Contact names, emails, phone numbers and notes are never sent to the model.

## Privacy and attribution

- Contacts are only **created** when someone gives their details to the business: email capture (with an explicit consent tick box), booking, signed-in enquiry, import, manual entry, or **Sync from leads & bookings**.
- Browsing is attributed only to people already known to that business:
  - Signed-in customers are matched by account email, user id or phone. A signed-in customer who is an existing lead becomes a contact.
  - Anonymous visitors are matched by a random visitor id (`localStorage` `uc_vid`), which is linked only when they submit the capture form.
- Owners viewing their own listing are ignored.
- Activity and personalisation are per business. One business never sees or references what a contact did at another business.
- Public endpoints always answer the same way whether or not the person is known, so they can't be used to probe a CRM.
- The unsubscribe GET only shows a confirmation page, because link scanners prefetch GETs. Unsubscribing happens on POST (the form or one-click).

## API

Authenticated routes are under `/api/crm/engagement`. All of them take `businessId` (query for GET, body otherwise). Users manage their own businesses; admins act on the owner's CRM.

| Method | Path | Body / query → response |
| --- | --- | --- |
| GET | `/catalog` | → `{ catalog: { signals, exitSignals, defaultExitSignals, stepConditions, purposes, tones, variables, defaults, maxSteps }, importFields, aiEnabled }` |
| GET | `/overview` | Seeds starters on first use → `{ settings, stats: { contacts: {total, marketable, unsubscribed, bounced, newLast30}, journeys: {active, converted, completed, exited}, emailsLast30: {sent, failed, skipped, clicked} }, aiEnabled }` |
| PUT | `/settings` | `{ enabled, frequency: {maxPerWeek, minHoursBetween}, sendWindow: {startHour, endHour}, timezone, importDailyLimit, aiTriage, captureWidget }` → `{ settings }` |
| GET | `/templates` | `archived=true` also lists archived templates → `{ templates: [{ _id, name, purpose, tone, source, subject, body, approvedAt, archived, starterKey, usedBy: [{id, name, isEnabled}] }] }` |
| POST | `/templates` | `{ name, purpose, tone, subject, body, approved?, source? }` → `{ template, notices }` |
| PUT | `/templates/:id` | Same body → `{ template, notices }`. A wording change clears approval unless `approved: true`. |
| POST | `/templates/:id/approve` | → `{ template }` |
| POST | `/templates/:id/duplicate` | → `{ template }` |
| PATCH | `/templates/:id/archive` | `{ archived }` → `{ template }` |
| POST | `/templates/preview` | `{ subject, body, contactId? }` → `{ preview: { subject, html, warnings } }` |
| POST | `/ai/template` | `{ action: generate/rewrite/improve, purpose, tone, instruction, subject, body, previousSubject }` → `{ draft: { subject, body, warnings } }` |
| POST | `/ai/plan` | `{ instruction? }` → `{ proposal: { summary, newTemplates: [{ref, name, purpose, tone, subject, body}], journeys: [{name, goal, rationale, trigger: {signal, params}, steps: [{templateId (id or new-template ref), delay, condition}], exitOn, priority, reentryDays}], warnings } }` |
| POST | `/ai/plan/apply` | `{ proposal }`, optionally edited or trimmed → `{ templates, journeys, warnings }` |
| GET | `/journeys` | → `{ journeys: [{ _id, name, goal, rationale, source, trigger, triggerLabel, steps: [{templateId, templateName, templateApproved, subject, delay, delayLabel, condition}], exitOn, priority, reentryDays, isEnabled, readyToEnable, stats: {active, completed, converted, exited, total, sent, failed, clicked} }] }` |
| POST | `/journeys` | `{ name, goal, trigger: {signal, params}, steps: [{templateId, delay: {amount, unit}, condition}], exitOn, priority, reentryDays }` → `{ journey, notices }` |
| PUT | `/journeys/:id` | Same body → `{ journey, notices }` |
| PATCH | `/journeys/:id/enabled` | `{ isEnabled }` → `{ journey }` |
| DELETE | `/journeys/:id` | → `{ deleted, exited }` |
| GET | `/enrollments` | `status, journeyId, contactId, page, limit` → `{ enrollments: [{ _id, status, contactId: {name, email, lifecycle, emailStatus}, journeyId: {name}, trigger, triggerLabel, enrolledAt, nextRunAt, currentStep, emailsSent, exitReason, endedAt, steps: [{index, templateName, delayLabel, condition, state: done/next/pending}], nextStepLabel, history: [{at, type, stepIndex, note}] }], total, page, totalPages }` |
| POST | `/enrollments` | `{ journeyId, contactId }`: add a contact by hand (all checks apply) |
| POST | `/enrollments/:id/stop` | → `{ stopped }` |
| GET | `/emails` | `trigger (journey or an automation trigger), status, journeyId, contactId, page, limit` → `{ logs: [{ trigger, status, to, subject, scheduledFor, sentAt, lastError, clickCount, contactId: {name, email}, journeyId: {name}, leadId }], total, page, totalPages }` |
| GET | `/contacts/:id/profile` | → `{ contact, lead, activities, enrollments, emails, marketing: { blockedReason, globallySuppressed } }` |
| PATCH | `/contacts/:id/email-preferences` | `{ status: "unsubscribed" }`, `{ status: "subscribed", permissionConfirmed: true }` or `{ permissionConfirmed: true }` → the profile |
| POST | `/contacts/bulk` | `{ action: tag/untag/unsubscribe/confirm_permission, contactIds, tags }` → `{ affected }` |
| POST | `/contacts/sync-existing` | → `{ summary: { leads, customers, created } }` |
| POST | `/imports` | multipart `file`, `businessId` → `{ importId, fileName, rowCount, truncated, maxRows, headers, preview, suggestedMapping: {header: field}, mappedBy, fields, dryRun }` |
| POST | `/imports/:id/validate` | `{ mapping }` → `{ dryRun }` |
| POST | `/imports/:id/commit` | `{ mapping, options: { duplicateMode, tags, consentConfirmed, engagement } }` → `{ importId, summary, errors, errorCount, triage }` |
| GET | `/imports` | → `{ imports: [{ fileName, status, rowCount, summary, options, triage: {status, decidedBy, segments, enrolled, waiting}, createdAt }] }` |
| GET | `/imports/:id` | → `{ import }` (with `rowErrors`) |
| GET | `/imports/:id/errors.csv` | CSV download |
| POST | `/imports/:id/retriage` | → `{ queued, result }` |

The existing contact routes (`/api/crm/contacts`) now also:

- filter by `tag`, `emailStatus`, `lifecycle` and `segment` (`marketable`, `no_permission`, `in_journey`, `waiting`), and sort by `engagement.lastActivityAt`
- accept `tags` and `permissionConfirmed` on create
- only update whitelisted fields

Public routes are under `/api/crm/engagement/public` and have no auth:

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/widget/:businessId` | `{ enabled, businessName }` |
| POST | `/capture` | `{ businessId, email, name?, consent: true, visitorId?, item?: {kind: business/service, name, id?}, website: "" (honeypot) }`. Rate-limited (10 per 15 minutes per IP). |
| POST | `/track` | `{ businessId, event: business_viewed/service_viewed/booking_started, item?, visitorId? }`, optional Bearer token. Always 202. |
| GET | `/unsubscribe?t=` | Confirmation page. |
| POST | `/unsubscribe` | Form fields `t` and `scope=business\|all`, or one-click. |
| GET | `/r/:token` | Tracked-link redirect. Only signed destinations. |

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CRM_LINK_SECRET` | derived from `JWT_SECRET` | HMAC key for unsubscribe and click links. Set it explicitly in production so rotating the JWT secret doesn't invalidate links. |
| `CRM_ENGAGEMENT_GLOBAL_DAILY_CAP` | 3 | Marketing emails per address per 24 hours, across businesses. |
| `CRM_CONTACT_IMPORT_MAX_ROWS` | 20000 | Rows read per import. |
| `IMPORT_FILE_SIZE_LIMIT` | 10 MB | Upload size. |
| `CRM_CAPTURE_RATE_MAX`, `CRM_TRACK_RATE_MAX` | 10 / 15 min, 120 / 5 min | Public endpoint rate limits. |
| `ANTHROPIC_API_KEY`, `CRM_AI_EMAIL_MODEL`, `CRM_AI_EMAIL_EFFORT` | | Same as email automation. |
| `BACKEND_URL`, `FRONTEND_URL` | | Links in emails. |

Sending needs the worker (`startWorker.js`) and Redis, like email automation. The worker builds the new collections' indexes on startup (`npm run indexes` includes them).

## Data

| Collection | Purpose |
| --- | --- |
| `CrmContact` (extended) | Adds `emailKey` (unique `businessId:email`), `userId`, `leadId`, `tags`, `lifecycle`, `emailStatus`, `consent`, `visitorIds` (hidden), `interests`, `bookings`, `engagement` and `triage` |
| `CrmContactActivity` | Contact timeline |
| `CrmEngagementSettings` | Per-business switches |
| `CrmEngagementTemplate` | Template library |
| `CrmJourney` | Journey definitions |
| `CrmJourneyEnrollment` | A contact's path through a journey; unique while active per journey and contact |
| `CrmContactImport` | Import history and triage outcome |
| `CrmEmailDispatch` (extended) | Adds `category`, `contactId`, `journeyId`, `enrollmentId`, `templateId`, `stepIndex`, `clickCount` and `firstClickedAt` |
