# Per-user social integrations

This is a tenant-scoped Bring Your Own App integration. Each tenant stores its own encrypted provider client ID, client secret, and redirect URI in `TenantSocialCredential`. Every OAuth transaction is tied to both tenant and authenticated user through a one-time, expiring, hashed state record. Twitter/X additionally uses PKCE. Provider tokens are encrypted with `ENCRYPTION_KEY`, stored in `SocialConnection` or `GoogleBusinessConnection`, excluded by default from Mongoose queries, and never returned by the API.

## Provider boundaries

- Facebook connects the user and discovers the Pages they can manage. Publishing supports Page feed, photo, and hosted-video URL posts and requires the user-selected Page ID and its Page access token; personal Facebook profile publishing is not implemented because the official Graph API does not provide that workflow.
- Instagram uses Instagram Login for professional accounts and the official media-container then publish workflow. Media must be publicly reachable by Instagram. The official long-lived token exchange and refresh endpoints are used.
- Threads uses its separate Threads App ID and App Secret, `threads_basic` plus `threads_content_publish`, the container/publish workflow, and long-lived Threads token refresh. Threads credentials are not interchangeable with the parent Meta App Secret.
- LinkedIn uses 3-legged OAuth, `openid profile email w_member_social`, `/v2/userinfo`, and the versioned REST Posts API. The current publisher is text-only and rejects media instead of silently dropping it. Programmatic refresh is used only when the application is approved for it; otherwise the user must reconnect.
- Twitter/X uses OAuth 2 authorization-code + PKCE with `offline.access`. The current publisher supports text-only posts. Media upload is intentionally rejected until the project implements the platform's separate official media-upload authorization workflow.
- Pinterest uses OAuth 2, user-selected boards, `/v5/pins`, and continuous refresh tokens for eligible applications. A board ID and public image URL are required for a Pin.
- Google Business Profile is read-only. The integration uses `business.manage`, lists accounts and locations, gets locations with a read mask, and performs no Google PATCH, PUT, POST, DELETE, or update operation. Local profile population only writes to this application's database.

## Credential setup

Credentials must be entered through `/settings/integrations`. They are encrypted into `TenantSocialCredential`; provider secrets must not be placed in `.env` or frontend variables. The UI displays the exact backend callback URI that must be registered for each provider.

X requires the OAuth 2.0 Client ID and Client Secret from User authentication settings. Consumer API keys and an app-only bearer token cannot authorize user posting. Google Business Profile needs a Web application OAuth client whose callback ends in `/api/google-business/callback`; the portal Google Sign-In client is separately configured through `GOOGLE_CLIENT_ID` and `VITE_GOOGLE_CLIENT_ID`.

Scheduling is application-side via BullMQ. The provider APIs are not treated as supporting native scheduling; each scheduled job publishes through the user's own connection when it runs. A 429/5xx response is retried with bounded exponential backoff, and each platform result is recorded independently.
