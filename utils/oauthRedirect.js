"use strict";

function frontendBaseUrl() {
  const configured = process.env.FRONTEND_URL || "http://localhost:5173";
  try {
    return new URL(configured.endsWith("/") ? configured : `${configured}/`);
  } catch {
    return new URL("http://localhost:5173/");
  }
}

function resolveFrontendReturnTo(returnTo, fallbackPath = "/settings/integrations") {
  const frontend = frontendBaseUrl();
  if (!returnTo) return new URL(fallbackPath, frontend);
  try {
    const candidate = new URL(returnTo, frontend);
    if (candidate.origin !== frontend.origin) return new URL(fallbackPath, frontend);
    return candidate;
  } catch {
    return new URL(fallbackPath, frontend);
  }
}

function oauthResultUrl(returnTo, result) {
  const url = resolveFrontendReturnTo(returnTo);
  Object.entries(result || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  });
  return url.toString();
}

module.exports = { frontendBaseUrl, resolveFrontendReturnTo, oauthResultUrl };
