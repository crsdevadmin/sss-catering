# SSS Catering — Festival Ordering App

Festival pre-ordering for SSS Catering: sweet boxes, savoury boxes, hampers,
Sadhya and bulk catering across 11 festivals, with cut-off dates, delivery
slots, part-payment and a kitchen admin panel.

Plain HTML, CSS and JavaScript on the frontend, with a dependency-free Node.js
backend for Razorpay and SQLite order storage. It installs from the browser as
an app — no Play Store and no App Store.

## Live site

<!-- Replace after you enable GitHub Pages -->
https://YOUR-USERNAME.github.io/sss-catering/

## Running locally

Node.js 22.5 or newer is required.

1. Copy `.env.example` to `.env`.
2. Add the Razorpay Test Mode Key ID, Key Secret and webhook secret.
3. Run `npm start`.
4. Open `http://localhost:3000`.

The Razorpay secret is read only by the server. Never put it in `index.html`
or commit `.env` to Git.

## Razorpay configuration

1. Generate Test Mode API keys in the Razorpay Dashboard.
2. Set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` in `.env`.
3. Enable automatic payment capture in Razorpay. The backend also captures an
   authorized payment as a fallback.
4. Create a webhook at `https://YOUR-DOMAIN/api/webhooks/razorpay`.
5. Subscribe to `payment.captured`, `payment.failed` and `refund.processed`.
6. Put the same webhook signing secret in `RAZORPAY_WEBHOOK_SECRET`.
7. Complete successful, failed and cancelled Test Mode payments before using
   Live Mode keys.

Orders are stored in `data/orders.sqlite`. This file must be included in the
server's backup policy.

## Hosting

The live application now requires a Node.js host such as AWS Lightsail.
GitHub Pages alone cannot securely create or verify Razorpay orders.

### Legacy static-only instructions

1. Push this folder to a **public** repository named `sss-catering`.
   (GitHub Pages on a private repo needs a paid plan.)
2. In the repository: **Settings → Pages**.
3. Under *Build and deployment*, set **Source: Deploy from a branch**,
   **Branch: `main`**, **Folder: `/ (root)`**, then Save.
4. Wait about a minute. The site appears at
   `https://YOUR-USERNAME.github.io/sss-catering/`.

That address is HTTPS, which is what lets phones install the app.

### Using your own domain

Buy the domain (about ₹800–1,200 a year), then add a file named `CNAME` to
this folder containing one line — for example `ssscatering.in` — and point the
domain's DNS at GitHub Pages. Settings → Pages → Custom domain has the exact
records.

Netlify Drop and Cloudflare Pages work too: drag this folder in, no git needed.

## Installing on a phone

The app must be on an HTTPS address first (the GitHub Pages URL is one).

| Device | How |
| --- | --- |
| Android | Open in Chrome → three-dot menu → **Install app** |
| iPhone / iPad | Open **in Safari** → Share → **Add to Home Screen** |
| Computer | Chrome or Edge → install icon in the address bar |

Chrome on iPhone cannot install apps — Apple only allows Safari.

Once installed it opens full screen with the app icon, and the menu still
loads with no internet.

## How orders reach the kitchen

Every confirmed order builds a formatted summary — items, sizes, options,
slot, address, bill and the amount to collect — and opens WhatsApp to
**+91 98408 51067**. Payment settings (cash on delivery, the COD cap, advance
rules) are under **Account → Admin Dashboard → Today**.

## Files

| File | What it is |
| --- | --- |
| `index.html` | Customer app, cart and Razorpay Checkout UI |
| `server.js` | Secure order creation, payment verification and webhook API |
| `data/orders.sqlite` | Runtime order database (created automatically) |
| `manifest.webmanifest` | Name, colours and icons used when installing |
| `sw.js` | Offline cache. **Bump `CACHE` after editing `index.html`** |
| `icon-192.png`, `icon-512.png` | App icons |
| `apple-touch-icon.png` | iPhone home-screen icon |
| `.nojekyll` | Stops GitHub Pages running Jekyll over these files |

## Editing the menu

Festivals and combos live in the `FEST` array near the top of the `<script>`
block in `index.html`. Each festival carries its dates, cut-off rule, theme,
CTA and its priced items. Change a price there and it updates everywhere —
menu, product page, cart and the WhatsApp summary.

After any edit, bump the `CACHE` version string at the top of `sw.js`,
otherwise phones that already installed the app keep serving the old copy.

## Current limits

Customer and payment orders are persisted in SQLite. The customer-facing order
history is still cached on that customer's device, and the kitchen summary is
sent through the WhatsApp button. A secured shared staff dashboard and
automatic WhatsApp Business messages are separate additions.
