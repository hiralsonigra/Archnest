# ArchNest Studio — website + admin (one folder)

index.html  = website        admin.html = admin panel        server.js = backend (saves data for all visitors)

## Easiest (double-click, no install)  — "Local mode"
Open index.html, then admin.html from the same folder in the same browser (Chrome/Edge).
First time admin.html asks you to create an email + password. It shows the bookings and quotes made
in THIS browser only (good for testing). It is not secure for real use and cannot see other people's bookings.

## Real mode (all visitors' bookings + payments)
1. Install Node.js LTS from https://nodejs.org
2. Windows: double-click START-WINDOWS.bat   |  Mac/Linux: START-MAC-LINUX.command
   (first start asks for admin email + password)
3. Website: http://localhost:3000    Admin: http://localhost:3000/admin

Open the site through that address (not by double-clicking index.html) so bookings reach the server.

## Going live
Host this folder on a Node host, behind HTTPS, with COOKIE_SECURE=1. Back up data/db.json.
Not included: payment gateway, email/SMS alerts, multiple admins. Payments are recorded by hand in the admin.

## New in this version
- **Studio location**: edit `const STUDIO={...}` near the bottom of index.html (address, lat/lng, phone, email, hours). Visitors see "Visit Us & Share Location" and can open/share it.
- **Client → owner location**: booking form, billing address, and the Visit section have "Use my location" (needs browser permission; on file:// type the address instead). Admin shows an "Open map" link.
- **Share quote**: ✉ Email to client / WhatsApp buttons in Billing (opens your mail app / WhatsApp with the estimate filled in).
- **Project Workflow tracking**: client enters QT-/BK- reference; chips colour by real status/payment.
- **Admin**: account button (top right) → "Admin login", and footer link.
- **Professional photos**: edit `DPH` in index.html to use real people/portfolio photos.

## My Account hub (top-right 👤)
- **Project**: draggable 3D house that builds with project progress/payment, live status of all your references (QT-/BK-), Message studio (WhatsApp/email), Status PDF.
- **Find anything** search bar: understands English/Hindi/Hinglish words (bedroom, sofa, estimate, location, book…) and jumps to the right section. It is keyword matching, not a cloud AI.
- **Favourites**: ♡ on products and Inspiration styles; send the shortlist to the studio by WhatsApp/email.
- **Profile**: saved in the visitor's browser, auto-fills booking/billing/location forms.
- **Updates**: red dot on the account button when a tracked project's status/payment changes (checked every 45 s; needs server mode).
- Set `STUDIO.phone` / `STUDIO.email` so Message/Email buttons reach you directly.

## v10 additions
- Floating WhatsApp button (needs `STUDIO.phone`), FAQ + "How we work", Privacy / Terms / Help pages (template text — have them checked).
- Site-visit **time slots** in the booking form (Mon–Sat, 10:00–17:00; a slot can be booked once; Sundays closed).
- **Download PDF** of the estimate (Billing) — a real .pdf file, no library.
- Language switch **EN / हिं / ગુજ** (menus, headings, main buttons).
- Real reviews: fill `STUDIO.reviews=[{name,project,text,stars}]` in index.html — they replace the sample testimonials.
- Admin: project **notes** and **file upload** (PDF/JPG/PNG/WEBP, 2 MB, server mode), booking time slot shown.
- Server: optional **e-mail** (SMTP) and **Razorpay** payment links — see HOSTING.md and .env.example.

## v11 fixes
- 3D Studio: camera distance now fits the room size (large rooms / stacked floors no longer put the camera inside the walls); broken saved items are skipped; Reset restores the sample room.
- 2D editor: new **🖐 View / Pan** tool, zoom ＋/－, Fit, 1:1 and mouse-wheel zoom (right/middle-drag also pans).
- My Account → Favourites: WhatsApp / Gmail / Email app / Copy buttons with a visible message box.
- Admin → **Clients** tab shows profiles + shortlists clients saved in My Account (server mode: from all visitors; local mode: this browser).

## 3D library
`assets/three.min.js` (three.js r128, MIT) is bundled, so the 3D studio works offline. Keep the `assets` folder next to `index.html`.

## Firebase (optional)
Fill `assets/firebase-config.js` and publish `firestore.rules` — see SETUP-FIREBASE.md. Leave the config empty to keep using
server.js / the browser as before. No existing function was changed: Firebase is plugged in underneath (`assets/fb.js`).

## What changed in this version
- **Fewer files (51 instead of 378):** all 328 product pictures are packed into one file, `assets/products.js` (converted to WebP). Do not delete it. The old `assets/p/` folder is gone.
- **Profile page:** the 👤 button in the header (or `index.html#profile`) opens a full profile page: name, phone, email, city, address, property type, budget, notes, download my data, clear from device. Saving sends it to the studio (shows in Admin → Clients).
- **Firebase:** fill `assets/firebase-config.js` and publish `firestore.rules` (see SETUP-FIREBASE.md). The profile (including the new `more` field) then saves to the Firestore `profiles` collection. If you already published the old rules, publish the new `firestore.rules` again.
