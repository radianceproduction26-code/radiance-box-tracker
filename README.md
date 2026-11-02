# Radiance Box Tracker (cloud version)

Print QR box labels, track finished goods (FG) stock, and see assembly-out per date, from one database.
No local server and no office WiFi needed: the web app and the phone apps all talk to Supabase over the internet.

```
web/        Web app for the assembly PC (plain HTML + JS, no build step, hosted on Vercel)
supabase/   Database changes (migrations)
tests/      Automated browser test + a stand-in Supabase server
```

## What works now (Phase 1 to 4)

| Screen | Who | What it does |
|---|---|---|
| FG inward | store, fg, admin | Phone or PC camera scans each box QR as it reaches the store: green = received, red = reason. Optional rack, last 20 scans, in-transit count, type-in fallback |
| FG outward | fg, dispatch, admin | Fill slip details (known parties fill themselves), scan every box going on the truck (camera or type-in), FIFO warning, totals by part, then **Create packing slip**. All-or-nothing: one bad box stops the slip and nothing is dispatched |
| Slips | everyone (void: admin) | All packing slips with search and status; open one to download its PDF again; admin can void a slip (boxes return to FG stock, slip stays on record) |
| Print labels | assembly, admin | Makes 1–200 boxes at once, each with its own Box ID and QR, prints 101.6 × 63.5 mm labels |
| Box register | everyone (void and reprint: assembly, admin) | Search by status, part, Box ID, date; reprint ticked labels; void a box with a reason; CSV download |
| Reports | everyone | Assembly out per date, FG inward per date, dispatch per date, with day totals and CSV |
| Home | everyone | FG stock by part, today's assembly out / inward / dispatch |
| Parts | assembly, admin | Import CHECKLIST_….xlsx (sheet MB), edit part names |
| Opening stock | admin | One-time upload of FG already in the store |
| Users | admin | Give each login a name and a role |

Coming next: reports and exports (Phase 5), offline queue (6), parallel run (7). A native Android app (Flutter) is optional:
the inward and outward pages already work on Android Chrome and iPhone Safari.

## Roles
`assembly` prints, reprints, voids · `store` scans FG inward · `dispatch` scans outward and makes packing slips ·
`fg` does both inward and outward (one login for the FG store person on the iPhone) · `viewer` read only · `admin` everything. A login with no role (or switched off) sees nothing: this is enforced by
the database (Row Level Security), not only by the screens.

## Set-up (one time)

1. **Supabase** (already created: project `radiance-box-tracker`, Mumbai).
   - Authentication → Sign In / Providers → turn **off** "Allow new users to sign up".
   - Add each person: Authentication → Users → Add user → email + password, tick "Auto Confirm User".
   - Then sign in to the web app as admin → **Users** → set name and role.
2. **Vercel**: New Project → import this GitHub repo → **Root Directory = `web`** → Framework Preset = *Other* →
   leave Build Command and Output Directory empty → Deploy. (Or drag the `web` folder onto vercel.com/new.)
3. **Label PC** (the one with the Datamax DMX 400):
   - Install the Datamax driver; in *Printing Preferences* set paper to **101.6 × 63.5 mm (4 × 2.5 in)**, media = labels with gap sensor, margins 0, scale 100 %. Make it the Windows default printer.
   - Start Chrome with silent printing so labels go straight to the printer:
     `"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk-printing https://YOUR-APP.vercel.app`
     (put this in a desktop shortcut).
4. **Phone** (FG store person): open `https://YOUR-APP.vercel.app` in Safari (iPhone) or Chrome (Android), sign in with a login whose role is `fg`, then *Add to Home screen* so it opens like an app. Open **FG inward** to receive boxes or **FG outward** to dispatch, press **Start camera**, allow the camera.
   Hold the label 15–25 cm away in good light. The camera needs https (Vercel gives that).
5. **First use**: sign in as admin → *Parts* → choose the CHECKLIST file → Import → *Opening stock* → upload →
   then *Print labels*.

The Supabase address and publishable key are in `web/js/config.js`. The publishable key is meant to be public;
what protects the data is the login plus the database rules.

## Packing slip
The PDF is made inside the app (no library) in the same *Delivery challan cum Packing Slip* layout as the old kit, plus a Box ID list page.
Company address, invoice creator name and trays per box are in `web/js/config.js` (`COMPANY`). On the iPhone, **Share / print PDF**
opens the share sheet (AirPrint, WhatsApp, Save to Files); on a PC it downloads the PDF. Slip number `SL-YYMMDD-NNN`.

## Database changes
`supabase/migrations/005_fg_role_and_slip_void.sql` adds the `fg` role, `void_slip`, the `slip_summary` view, and lets `fg` use the inward and
outward functions. It is already applied to the Supabase project. (001 to 003 live in the project; export them with `supabase db pull`.)

## Label
Same fields as the old kit: RADIANCE POLYMERS, ACCEPTED, Unique Code (Box ID / date / lot), Part No, Part Name,
Qty NOS, Date, QA Sign, Box ID, 25.4 mm QR (203 dots at 203 dpi, 7 dots per QR module so it prints sharp).
The QR contains only the Box ID. Long part names / lots shrink to fit instead of being cut off.

## Box ID
`RP-YYMMDD-NNNNN` (India date, one running number for all days). Slip number `SL-YYMMDD-NNN`.

## Tests
```
python3 tests/t_app.py . /path/to/CHECKLIST_Bavare.xlsx     # needs: playwright (chromium), opencv, openpyxl
```
Runs the web app in headless Chrome with the real Content-Security-Policy against a stand-in Supabase server:
login and roles, CHECKLIST import (177 parts / 233 pack sizes), label creation, QR decode from the printed label,
print page size, register, void, reports, opening stock, users, token refresh, network failure.

```
python3 tests/t_scan.py .       # FG inward with a FAKE CAMERA
python3 tests/t_outward.py .    # FG outward + packing slip PDF with a fake camera (reads the PDF back with pdftotext)
python3 tests/shots.py .        # screenshots of the main screens into tests/out/shots (visual check)
```
Feeds Chromium a video of the real printed-label images (rotated, tilted, blurred, noisy, plus a stranger QR) and checks
that the page reads them, receives the boxes once, ignores a box held in front of the camera, shows red reasons
(already received, not in register, void, no connection), remembers the rack, and keeps other roles out.
The phone's own QR detector (Android Chrome `BarcodeDetector`) is used when present; otherwise the built-in decoder in
`web/js/qrdecode.js` reads the frames (iPhone, desktop). Only the built-in decoder is exercised in the sandbox.

Not covered by these tests (needs the real thing): the browser talking to the live Supabase project, and a
physical print on the Datamax. Do these two first on the label PC: sign in, print 2 labels, scan one with a phone.
