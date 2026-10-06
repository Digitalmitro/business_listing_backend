# Appointment emails and reminders

Booking confirmation, the reminder series before an appointment, and the
reschedule / cancellation notices. Everything is measured from the appointment's
exact start time, stored on the appointment as `startsAt`.

## What is sent, to whom, when

| Email | Recipient | When | EmailTemplate trigger |
| --- | --- | --- | --- |
| Booking confirmation | customer, business owner | immediately after booking | `booking_confirmed_user`, `booking_confirmed_owner` |
| Reminder | customer | 3 days before `startsAt` | `booking_reminder_3d_user` |
| Reminder | customer | 2 days before | `booking_reminder_2d_user` |
| Reminder | customer | 1 day before ("tomorrow") | `booking_reminder_1d_user` |
| Reminder | customer | 30 minutes before | `booking_reminder_30m_user` |
| Reminder | customer | 10 minutes before | `booking_reminder_10m_user` |
| Rescheduled | customer, owner | immediately after a reschedule (the new appointment) | `booking_rescheduled_user`, `_owner` |
| Canceled | customer, owner | immediately after a cancellation | `booking_canceled_user`, `_owner` |

Wording lives in `EmailTemplate` documents (Admin panel → Email Management; seed
them with `node scripts/seedTemplates.js`, or `--refresh=booking_` to overwrite
the booking ones with the shipped wording). When no template exists for a
trigger, the built-in wording in `services/appointmentNotificationService.js`
is used, so emails are sent either way. Placeholders: `{{recipient_name}}`,
`{{customer_name}}`, `{{business_name}}`, `{{service_name}}`,
`{{appointment_date}}`, `{{appointment_time}}`, `{{timezone}}`,
`{{appointment_id}}`, `{{business_phone}}`, `{{booking_link}}`,
`{{frontend_url}}`, plus `{{reminder_when}}` ("in 3 days", "tomorrow", ...) in
reminders and `{{old_date}}` / `{{old_time}}` in reschedule notices.

## How timing works

- A booking is a calendar date + a time slot ("11:00 AM") in a timezone. The
  timezone is, in order: the business's CRM engagement settings timezone, the
  `timezone` the booking client sent (the public booking page sends the
  browser's zone), the owner's profile zone, the customer's profile zone, then
  `APPOINTMENT_DEFAULT_TIMEZONE` (default `Asia/Kolkata`).
- `appointmentDate` is stored as midnight UTC of the calendar date (unchanged
  from before; the slot-conflict check compares it exactly). `startsAt` is the
  exact instant of date + slot in that timezone, e.g. `2026-10-06` + `11:00 PM`
  in `Asia/Kolkata` = `2026-10-06T17:30:00Z`. DST is handled by `moment-timezone`.
- Each reminder is due at `startsAt - offset`. For an 11:00 PM appointment the
  30-minute reminder is due at 10:30 PM and the 10-minute one at 10:50 PM, in the
  appointment's own timezone, whatever the server's timezone is.
- Steps whose time has already passed when the booking is made are recorded as
  `skipped` (never sent late). A reminder found late by the worker (an outage) is
  sent only within its tolerance (12 h for the day reminders, 15 min for the
  30-minute one, 8 min for the 10-minute one) and never once the appointment has
  started. A confirmation is still sent up to a day after the start.
- `APPOINTMENT_REMINDER_SCHEDULE` picks the steps (default `3d,2d,1d,30m,10m`).

## How delivery works

```
POST /api/appointment  ──► Appointment { startsAt, timezone }
                       ──► AppointmentNotification rows: one per email
                           (unique appointment + key + recipient)
                       ──► "booking-email" job for anything due now

worker sweep (every APPOINTMENT_NOTIFICATION_SWEEP_SECONDS, default 60)
   recoverStaleSending   rows stuck in "sending" > 15 min -> failed (never re-sent)
   backfillAppointments  Scheduled appointments with no plan yet -> startsAt + rows
   enqueueUpcoming       rows due within the next window -> delayed job at the exact time
   sendDue               rows a job missed -> sent inline

processNotification(row)
   claim scheduled -> sending (findOneAndUpdate: only one caller wins)
   re-check the appointment (exists, status, start time, reminder window)
   render EmailTemplate (or built-in wording) -> deliver() -> sent | failed | skipped
   failed: retried after 5 / 10 / 20 min (APPOINTMENT_EMAIL_MAX_ATTEMPTS), never past the start
```

`deliver()` uses the active `SenderEmail` (SMTP settings from the admin panel),
or the `EMAIL_USER` / `EMAIL_PASS` Gmail fallback when none is active. The
customer's emails carry the owner's address as Reply-To.

The rows are the source of truth, so a lost Redis job, a worker restart, or an
API process that could not reach Redis never loses an email, and the claim means
one is never sent twice however often a job is retried.

## Operations

- The emails are sent by the **queue worker process** (`startWorker.js`, PM2 app
  `business-listing-workers`, or the API itself when `INLINE_WORKERS=true`). If no
  worker runs, nothing is sent: `GET /health/ready` reports
  `"workers": { "status": "ready" | "missing" }` from the worker heartbeat, and
  `deploy.sh` warns when it is missing.
- Delivery log per appointment: `GET /api/appointment/:id/notifications`
  (customer, owner or admin), or the `appointmentnotifications` collection.
- Appointments booked before this shipped are backfilled by the sweep:
  `startsAt` is computed, future reminders are scheduled, and a confirmation is
  sent only if the booking is younger than `APPOINTMENT_CONFIRMATION_BACKFILL_HOURS` (24).
- Indexes: built by the worker on startup, or `npm run indexes`.

## Tests

- `services/appointmentTimeService.test.js`, `services/appointmentNotificationService.test.js`
  (unit; part of `npm test`).
- `tests/appointmentNotifications.integration.test.js` (local MongoDB only):
  `CRM_TEST_MONGO_URI=mongodb://127.0.0.1:27999/uc_appointment_test npm run test:integration`
