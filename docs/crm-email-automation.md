# CRM email automation (AI Email)

Business owners can have the CRM send the right email automatically when a lead or booking reaches a key moment. Each automation belongs to one Business, like the rest of the business-wise CRM, and is managed in the customer CRM suite under **CRM & Social Suite → Email Automation** (`/crm-suite?businessId=…`).

The setup flow in the UI is **Trigger → Template → Timing → Preview → Enable**.

## Triggers

| Trigger key | Fires when | Timing measured from | Default |
| --- | --- | --- | --- |
| `new_lead` | A lead enters the business's CRM from the profile enquiry form (`crmLeadIntakeService.createLeadFromEnquiry`) or is created in the CRM (`POST /api/crm/leads`). CSV imports and leads created directly in Booked/closed stages do not fire it. | the event (0 = immediately) | Immediately |
| `lead_viewed` | A signed-in customer opens the business's listing page and is already a lead of that business (matched by email, then phone). Leads that are Booked, won or lost are ignored, and so is the owner. | the event | 2 hours after |
| `booking_created` | A customer books (`POST /api/appointment`). Reschedules are not re-confirmed; their reminders still go out for the new time. | the event | Immediately |
| `booking_reminder` | A booking is coming up. | before the booking start | 1 day before |
| `booking_day` | The morning of the booking. Early bookings get it one hour before instead. | booking day, at `sendHour` | 8:00 AM |
| `booking_completed` | The booking has taken place. There is no "completed" transition in the booking flow, so this uses the booking start time plus the delay, for bookings that are Scheduled or Completed. | after the booking start | 2 hours after |
| `booking_followup` | A few days after the booking. | after the booking start | 3 days after |

The booking start is the appointment date plus its `timeSlot` (see `crmScope.appointmentStartTime`), in the worker server's local time, which is the same timezone used to store appointment dates.

### Detection and scheduling

- **Event triggers** (`new_lead`, `lead_viewed`, `booking_created`) are detected in the request that caused them. They create a `CrmEmailDispatch` and queue a BullMQ job on `crm-email-automation`, delayed if a delay is set. These hooks never throw, so automation problems cannot break a booking, an enquiry or a page view.
- **Scheduled triggers** (`booking_reminder`, `booking_day`, `booking_completed`, `booking_followup`) are evaluated by the scheduler sweep in the worker process (`startWorker.js`), every `CRM_EMAIL_AUTOMATION_SWEEP_MINUTES` (default 5). The sweep takes a Redis lock, like the lead follow-up scheduler. Each sweep:
  1. marks dispatches stuck in `sending` for more than 15 minutes as failed. They are not retried, because the email may already have gone out.
  2. finds bookings whose send time has passed, and creates their dispatches.
  3. sends every due dispatch, including anything the queue missed.
- Reminders only go out while the booking is still in the future, and at most 12 hours late (for example, after worker downtime).
- After-booking emails go out at most 48 hours late, and never for bookings whose send time was before the automation was switched on. Enabling a follow-up does not email old customers.
- Event triggers are not backfilled: enabling `new_lead` does not email existing leads.

### Sending and delivery status

At send time the worker claims the dispatch atomically (`scheduled` → `sending`) and re-checks:

- that the automation is still enabled and approved
- that the booking has not been canceled or rescheduled, and hasn't already started (for reminders)
- that the lead still exists
- the recipient

The recipient is the lead's email, else the booking customer's account email, else the email of the account that submitted the enquiry. Unsubscribed addresses (`UnsubscribedEmail`, or users with `subscribedToEmails: false`) are skipped.

Mail goes through the existing infrastructure: the active `SenderEmail` SMTP account (via `utils/nodemailer.js`, with the business name as the sender name and the owner's email as Reply-To), otherwise the Gmail fallback in `services/sendMail.js`. Every email gets an unsubscribe link to `GET {BACKEND_URL}/api/unsubscribe?email=…&source=crm_followup&format=html`. SMTP credentials never leave the server.

Each `CrmEmailDispatch` records one of these statuses:

| Status | Meaning |
| --- | --- |
| `scheduled` | Waiting for its send time, or for a retry. |
| `sending` | Claimed by a worker. |
| `sent` | Delivered to SMTP. Stores the recipient, the rendered subject and body, the `messageId` and `sentAt`. |
| `failed` | Failed after `CRM_EMAIL_AUTOMATION_MAX_ATTEMPTS` attempts (default 3; retries back off 5, 10, 20… minutes). `lastError` holds the reason. |
| `skipped` | Not sent for a reason stored in `lastError`: no email address, unsubscribed, booking canceled, automation switched off, and so on. |

Sent and permanently failed emails are also added to the lead's timeline. The CRM shows per-trigger counts and a filterable delivery log.

## Duplicate protection

Every dispatch has a unique `dedupeKey`:

- `booking_*` triggers: `<trigger>:appt:<appointmentId>`, so one email per booking and trigger.
- `new_lead`: `new_lead:lead:<leadId>`, so one email per lead.
- `lead_viewed`: `lead_viewed:lead:<leadId>:<YYYY-MM>`, so at most one per lead per calendar month.

The unique index means repeated events, overlapping sweeps and concurrent workers cannot create a second email. The atomic claim means the queue job and the sweep cannot both send the same one.

## Templates and variables

Every trigger comes with three ready-made templates: Professional, Friendly and Promotional (`services/crmEmailAutomationCatalog.js`). The owner picks one, edits the subject and HTML body, and saves their own copy on the automation.

Supported variables:

- `{{lead_name}}`
- `{{business_name}}`
- `{{store_name}}` (the listing name; currently the same as the business name)
- `{{service_name}}`
- `{{booking_date}}`
- `{{booking_time}}`
- `{{booking_link}}` (the customer's booking history page)
- `{{listing_url}}`

Validation rejects unknown variables, and warns about variables that will be blank for a trigger (for example `{{booking_date}}` in a New lead email). It also strips scripts, iframes, event handlers and `javascript:` links from the body, and newlines from the subject. Values are HTML-escaped when inserted into the body.

## AI assistant

`POST /api/crm/email-automation/ai/generate` drafts or rewrites an email with Claude (`services/crmEmailAiService.js`, official `@anthropic-ai/sdk`):

- `action: "generate"`, with an optional instruction such as *"Generate a friendly reminder for tomorrow's booking."*
- `generate` with `previousSubject`, used for **Regenerate**.
- `action: "rewrite"` with `tone`, used for **More professional / friendly / promotional**.

Safety rules:

- The endpoint only returns a draft; it never saves anything.
- Saving marks the wording approved only when the owner explicitly approves it (`approved: true`, the review checkbox in the preview step).
- Changing the wording clears the approval and switches the automation off.
- An automation cannot be enabled, and nothing is sent, without an approved template. The worker checks this again at send time.
- Prompts contain the business name, the trigger and the owner's own instruction or draft. Lead and customer data is never sent to the model.
- Placeholders the model invents are removed and reported back as warnings.
- The API key stays on the server. Without `ANTHROPIC_API_KEY` the endpoint returns 503 and the UI hides the assistant.
- The endpoint is rate-limited by `CRM_AI_RATE_MAX` per `CRM_AI_RATE_WINDOW_MS` (default 30 per 15 minutes), when rate limiting is enabled.

Requests use `claude-opus-5` with structured JSON output (`output_config.format`) and server-side refusal fallbacks (`fallbacks: "default"`).

## API

All routes require a JWT. `businessId` is required: users can only manage their own businesses, and admins act on the business owner's CRM (`crmScope.resolveWriteScope`).

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/crm/email-automation/catalog` | Triggers, variables, ready-made templates and `aiEnabled`. |
| GET | `/api/crm/email-automation?businessId=` | All seven triggers with saved or default template, timing, enabled flag and counts (`sent`, `failed`, `skipped`, `scheduled`, `lastSentAt`). |
| PUT | `/api/crm/email-automation/:trigger` | JSON: `businessId`, `subject`, `body`, `timing`, optional `presetKey`, `name`, `tone`, `source`, `approved`, `isEnabled`. Returns `warnings` and `notices`. |
| PATCH | `/api/crm/email-automation/:trigger/enabled` | JSON: `businessId`, `isEnabled`. Enabling requires a saved, approved template. |
| POST | `/api/crm/email-automation/preview` | JSON: `businessId`, `trigger`, `subject`, `body`, optional `leadId`. Renders with sample data and the real business name and link. |
| POST | `/api/crm/email-automation/ai/generate` | JSON: `businessId`, `trigger`, `action`, `tone`, `instruction`, `subject`, `body`, `previousSubject`. Returns `{ draft: { subject, body, warnings } }`. |
| GET | `/api/crm/email-automation/logs?businessId=&trigger=&status=&page=&limit=` | Delivery log. |
| POST | `/api/crm/email-automation/events/view` | JSON: `businessId`, optional `serviceName`. Called by the listing page for signed-in visitors. Always returns 202. |

`timing` takes one of two shapes:

- `{ amount, unit }`, where `unit` is `minutes`, `hours` or `days`. Allowed ranges: event triggers 0 to 7 days; `booking_reminder` 1 hour to 14 days; after-booking triggers 1 hour to 30 days.
- `{ sendHour }` (0–23), for `booking_day` only.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | – | Enables the AI assistant. |
| `CRM_AI_EMAIL_MODEL` | `claude-opus-5` | Model for drafts. |
| `CRM_AI_EMAIL_EFFORT` | `medium` | `low` / `medium` / `high`. |
| `CRM_AI_RATE_MAX`, `CRM_AI_RATE_WINDOW_MS` | 30, 900000 | AI endpoint rate limit. |
| `CRM_EMAIL_AUTOMATION_SWEEP_MINUTES` | 5 | Scheduler interval. |
| `CRM_EMAIL_AUTOMATION_MAX_ATTEMPTS` | 3 | Delivery attempts before a dispatch is marked failed. |
| `BACKEND_URL` | `https://server.urbancitations.com` | Public API origin used in unsubscribe links. |
| `FRONTEND_URL` | `https://urbancitations.com` | Used for `{{booking_link}}` and `{{listing_url}}`. |

Emails are only sent when the worker process (`business-listing-workers` in PM2, or `INLINE_WORKERS=true`) is running and Redis is available.

## Data

- `CrmEmailAutomation`: one document per `{ businessId, trigger }` (unique). Holds the template (`presetKey`, `name`, `tone`, `source`: preset/custom/ai, `subject`, `body`, `approvedAt`, `approvedBy`), `timing`, `isEnabled` and `activatedAt`.
- `CrmEmailDispatch`: one document per email. Holds the unique `dedupeKey`, `leadId`, `appointmentId`, `scheduledFor`, `status`, `attempts`, `to`, the rendered `subject`/`body`, `messageId`, `lastError` and `sentAt`.

The app connects with `autoIndex: false`. The worker builds both collections' indexes when its scheduler starts, and `npm run indexes` (`scripts/createIndexes.js`) includes them as well. The unique `dedupeKey` index is part of the duplicate protection.
