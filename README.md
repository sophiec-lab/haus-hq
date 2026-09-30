# HAUS HQ

The HAUS Events company board, served at https://haus-hq.sophie-c.workers.dev.

- `src/index.html` is the whole app (markup, styles and script). Data comes live from Supabase, so most updates are data changes and need no deploy.
- `src/worker.js` serves the page and the icons in `src/assets`.
- Cloudflare deploys `main` automatically (Workers Builds, `npx wrangler deploy`). Roll back from Cloudflare, haus-hq, Deployments.
