// HAUS HQ worker
import HTML from "./index.html";
import appleTouch from "./assets/apple-touch-icon.png";
import icon192 from "./assets/icon-192.png";
import icon512 from "./assets/icon-512.png";
import iconMaskable512 from "./assets/icon-maskable-512.png";
import wordmarkCream from "./assets/wordmark-cream.png";
import wordmarkBlack from "./assets/wordmark-black.png";
var SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#111111"/><rect x="16.50" y="24.30" width="11.40" height="51.30" fill="#F7F4EF"/><rect x="50.80" y="24.30" width="11.40" height="51.30" fill="#F7F4EF"/><rect x="16.50" y="50.00" width="45.70" height="11.40" fill="#F7F4EF"/><circle cx="76.40" cy="68.45" r="7.15" fill="#D96B4F"/></svg>';
var ASSETS = {
  "apple-touch-icon.png": appleTouch,
  "icon-192.png": icon192,
  "icon-512.png": icon512,
  "icon-maskable-512.png": iconMaskable512,
  "wordmark-cream.png": wordmarkCream,
  "wordmark-black.png": wordmarkBlack
};
var MANIFEST = '{"name":"HAUS HQ","short_name":"HAUS HQ","description":"HAUS Events company command centre","start_url":"/","scope":"/","display":"standalone","background_color":"#111111","theme_color":"#111111","icons":[{"src":"/icon-192.png","sizes":"192x192","type":"image/png"},{"src":"/icon-512.png","sizes":"512x512","type":"image/png"},{"src":"/icon-maskable-512.png","sizes":"512x512","type":"image/png","purpose":"maskable"},{"src":"/icon.svg","sizes":"any","type":"image/svg+xml"}]}';
var worker_default = {
  async fetch(request) {
    const url = new URL(request.url);
    const p = url.pathname;
    if (p === "/healthz") return new Response("ok", { headers: { "content-type": "text/plain" } });
    if (p === "/icon.svg") return new Response(SVG, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });
    if (p === "/manifest.webmanifest") return new Response(MANIFEST, { headers: { "content-type": "application/manifest+json", "cache-control": "public, max-age=3600" } });
    const k = p.slice(1);
    if (Object.prototype.hasOwnProperty.call(ASSETS, k)) return new Response(ASSETS[k], { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" } });
    if (p === "/favicon.ico") return new Response(SVG, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });
    return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin" } });
  }
};
export {
  worker_default as default
};
