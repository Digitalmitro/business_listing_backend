# Per-user social integrations

This is a tenant-scoped Bring Your Own App integration. Each tenant stores its own encrypted provider client ID, client secret, and redirect URI in `TenantSocialCredential`. Every OAuth transaction is tied to both tenant and authenticated user through a one-time, expiring, hashed state record. Twitter/X additionally uses PKCE. Provider tokens are encrypted with `ENCRYPTION_KEY`, stored in `SocialConnection` or `GoogleBusinessConnection`, excluded by default from Mongoose queries, and never returned by the API.

## Provider boundaries

- Facebook connects the user and discovers the Pages they can manage. Publishing requires the user-selected Page ID and its Page access token; personal Facebook profile publishing is not implemented because the official Graph API does not provide that workflow.
- Instagram uses Instagram Login for professional accounts and the official media-container then publish workflow. Media must be publicly reachable by Instagram. The official refresh endpoint is used for long-lived Instagram tokens.
- LinkedIn uses 3-legged OAuth, `openid profile email w_member_social`, `/v2/userinfo`, and the versioned REST Posts API. Programmatic refresh is used only when the application is approved for it; otherwise the user must reconnect.
- Twitter/X uses OAuth 2 authorization-code + PKCE with `offline.access`. The current publisher supports text-only posts. Media upload is intentionally rejected until the project implements the platform's separate official media-upload authorization workflow.
- Pinterest uses OAuth 2, user-selected boards, `/v5/pins`, and continuous refresh tokens for eligible applications. A board ID and public image URL are required for a Pin.
- Google Business Profile is read-only. The integration uses `business.manage`, lists accounts and locations, gets locations with a read mask, and performs no Google PATCH, PUT, POST, DELETE, or update operation. Local profile population only writes to this application's database.

Scheduling is application-side via BullMQ. The provider APIs are not treated as supporting native scheduling; each scheduled job publishes through the user's own connection when it runs. A 429/5xx response is retried with bounded exponential backoff, and each platform result is recorded independently.
