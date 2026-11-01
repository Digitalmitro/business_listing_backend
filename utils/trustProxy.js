"use strict";

// `trust proxy` decides which X-Forwarded-For hop becomes req.ip (used by the rate
// limiters). `true` trusts every hop, so a client could send its own X-Forwarded-For and
// pick its IP; express-rate-limit warns about exactly that (ERR_ERL_PERMISSIVE_TRUST_PROXY).
// Production runs behind a single nginx, so trust one hop there; elsewhere only trust
// proxies on the loopback interface (e.g. a local dev proxy).
function resolveTrustProxy(value = process.env.TRUST_PROXY, nodeEnv = process.env.NODE_ENV) {
  if (value === "false") return false;
  if (value === undefined || value === "") return nodeEnv === "production" ? 1 : "loopback";
  if (value === "true") return 1; // legacy setting: treat as the single nginx hop
  if (/^\d+$/.test(value)) return Number(value);
  return value; // e.g. "loopback", "10.0.0.0/8"
}

module.exports = { resolveTrustProxy };
