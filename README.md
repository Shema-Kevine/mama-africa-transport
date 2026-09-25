# Mama Africa Transport

A role-based transport operations dashboard for managing taxis, drivers, trips, fuel, maintenance, and collections in Uganda. Administrators use the full fleet workspace; drivers use a simplified, privacy-aware portal.

## Administrator and driver access

On a fresh browser profile, the dashboard provisions the requested bootstrap administrator account automatically:

- **Username:** `admin`
- **Password:** `mamaafrica`

The static-only fallback provisions `admin` / `mamaafrica` for a fresh browser profile. The shared Docker API instead reads `ADMIN_USERNAME` and `ADMIN_PASSWORD` from `.env`; production refuses to start without an administrator password. Existing accounts are not overwritten. Administrators create and manage driver portal usernames and passwords from the Drivers page. Drivers cannot create or edit their own accounts; they sign in with the details supplied by the administrator.

In static-only mode, passwords and records remain in the browser. When the shared API is enabled, passwords are verified by the Node service, sessions use HttpOnly cookies, and the server enforces administrator/driver permissions. The driver portal exposes only the signed-in driver's read-only account summary and operational submission forms; the full fleet dashboard and account management remain administrator-only.

The driver portal never requests location on page load. In the trip view, the driver must explicitly tap **Share GPS location** before a position is sent; live GPS can then be started and stopped. The API requires a consent flag and records an audit event.

The administrator can export the driver database as CSV from the Drivers page. The export includes operational driver details and document references, but never includes password hashes or salts.

Administrator sections are connected through the sidebar and the Dashboard quick links. Each section also has a URL hash such as `#trips`, `#fuel`, or `#view-all`, so a page can be bookmarked or opened directly after sign-in.

## Run locally

Serve the directory from a local web server so browser storage and the map APIs work:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`. This is the static fallback mode; data is browser-local.

## Run the shared API

The repository includes a dependency-free Node API backed by SQLite. For a same-origin production-style deployment, use the Docker Compose configuration below. For local API development:

```bash
DATABASE_PATH=./data/mama-africa.sqlite \\
ADMIN_USERNAME=admin \\
ADMIN_PASSWORD='replace-with-a-long-random-password' \\
DOCUMENT_ENCRYPTION_KEY='replace-with-a-stable-secret' \\
PORT=3000 node server.js
```

The API process also serves the static frontend for local development, so after starting it open `http://localhost:3000`. The browser client automatically uses `/api` when the API health endpoint is available and falls back to local-only mode when it is not. The API provides server-side sessions, role-filtered state, collection synchronization, encrypted document storage, GPS consent enforcement, and audit logs. Set `APP_ORIGIN` when the API is accessed from a different origin. Important routes include `/api/auth/login`, `/api/state`, `/api/collections/*`, `/api/gps`, `/api/documents`, and `/api/audit`.

The repository includes a GitHub Actions workflow for syntax checks, API tests, and HTML validation. Run the same automated API checks locally with:

```bash
node --test test/api.test.js
```

Create a consistent SQLite backup with:

```bash
DATABASE_PATH=./data/mama-africa.sqlite node backup.js
```

## Run in Docker

The complete administrator/driver system can be packaged as Nginx plus the shared API and optional translation proxy. The API uses a persistent SQLite volume, server-side sessions, encrypted document storage, and role enforcement. Copy `.env.example` to `.env` and set a strong `ADMIN_PASSWORD` and `DOCUMENT_ENCRYPTION_KEY` before starting Compose.

For the complete system, use Compose so the Nginx frontend, shared API, persistent database volume, and optional translation proxy start together. The plain Docker command below serves the frontend only; run `Dockerfile.api` separately if Compose is unavailable.

```bash
docker build -t mama-africa-transport:latest .
docker run -d --name mama-africa-transport --restart unless-stopped -p 8080:80 mama-africa-transport:latest
```

Open `http://localhost:8080` after the frontend-only container starts.

To run the shared API without Compose, build `Dockerfile.api`, provide `ADMIN_PASSWORD` and `DATABASE_PATH`, and publish its port on your private network. The Nginx configuration expects the service name `api` on the Compose network.

If you run the command again and Docker reports that the container name already exists, remove the old container first:

```bash
docker rm -f mama-africa-transport
```

With the Docker Compose plugin installed, set the required secrets first:

```bash
cp .env.example .env
# edit .env and set ADMIN_PASSWORD and DOCUMENT_ENCRYPTION_KEY
docker compose up --build -d
```

Set `APP_PORT` to use another host port, for example `APP_PORT=9090 docker compose up --build -d`. Check whether the plugin is available with:

```bash
docker compose version
```

If that command reports `unknown command: docker compose`, install the Docker Compose plugin for your operating system or use the plain `docker build` and `docker run` commands above.

Check the container and health endpoint:

```bash
docker ps
curl http://localhost:8080/healthz
```

Stop or remove the Compose services with `docker compose down`. The API stores shared records in the `mama-africa-data` volume. If the API is not running, the UI deliberately falls back to browser-local storage. For production, serve the Nginx container behind HTTPS, restrict API origins, and back up the database volume.

### Containerized driver dashboard

The driver portal is part of the same production deployment as the administrator dashboard. After signing in with a driver account, the container provides one focused **What do you need to do?** menu. Selecting **Record a trip**, **Fuel**, or **Expenses & maintenance** opens only that view; the account icon opens a read-only identity summary. The administrator and driver views are role-separated in the same deployment, so a separate driver container is not required.

```bash
docker build -t mama-africa-transport:latest .
docker run -d --name mama-africa-transport --restart unless-stopped -p 8080:80 mama-africa-transport:latest
```

Open `http://localhost:8080`, sign in with a driver account created by the administrator, and choose an action from the menu. Use the account icon only to view the driver's identity and assigned taxi; account changes are handled by the administrator. With the Compose API running, driver-submitted trip, fuel, maintenance, GPS, and document records are shared across devices through the authenticated API.

## Google Maps search and navigation

The trip form uses Google Maps search and navigation when a Google Maps JavaScript API key is configured. It prefers the current Places API (New) and Routes API, with feature-detected fallbacks for older projects.

1. Enable **Maps JavaScript API**, **Places API (New)**, and **Routes API** for a Google Cloud project. For an older project, the legacy Places/Directions APIs are also supported.
2. Restrict the browser key by HTTP referrer and restrict it to the enabled APIs. Google Maps Platform billing must be enabled for production use.
3. Put the key in the `content` value of the `google-maps-api-key` meta tag near the top of `index.html`.

The app restricts searches to Uganda and supports roads, buildings, businesses, service centres, towns, landmarks, and other indexed places. If the key is empty or Google is unavailable, it falls back to listed-place search, a rate-limited OpenStreetMap lookup on explicit search, and offline distance estimates.

Press **Enter** after typing when Google is unavailable to request the OpenStreetMap fallback; ordinary keystrokes use the built-in suggestions without sending Nominatim autocomplete requests.

## Fuel prices

The fuel form loads `fuel-prices.json`, displays the available price for every fuel type, fills the rate when a station and fuel type are selected, and calculates the total as `litres × rate`.

The station field searches Google Places for `gas_station` results in Uganda and provides a **Browse Uganda fuel stations** action. Google returns the available indexed matches rather than a guaranteed exhaustive national directory. If a station is not returned, choose **Other fuel station**, enter its name/location, choose the fuel type, and enter the pump rate manually.

The bundled feed contains a dated Uganda national-average fallback because public station-level pricing is not provided by Google Maps and pump prices can vary by station. To use current station-specific quotes, host a JSON feed with this shape and change the `fuel-price-feed` meta value in `index.html`:

```json
{
  "currency": "UGX",
  "unit": "litre",
  "updatedAt": "2026-09-24",
  "source": "Your fuel-price provider",
  "nationalAverage": { "Petrol": 6875, "Diesel": 6725 },
  "stations": [
    { "id": "shell-kampala", "name": "Shell Kampala Road", "prices": { "Petrol": 6900, "Diesel": 6750 } }
  ]
}
```

Use the **Refresh prices** button after updating the feed. Fuel records store the applied source and update date so historical entries remain auditable.

## Maintenance providers and costs

Maintenance providers can be discovered through Google Places car-repair/garage results. If a provider is not listed, choose **Other service provider** and enter the provider name, address, website, telephone numbers, and email addresses manually. Use **Add another contact** for multiple contacts.

Maintenance records use a repeatable detailed cost breakdown. Add parts, labour, inspection, or other service lines; the total is calculated automatically. Odometer and separate parts-cost fields are intentionally not part of the maintenance form.

## Taxi GPS

The Taxis page includes a fleet GPS panel with a map, per-taxi status, coordinates, accuracy, last-update time, one-time GPS capture, and live tracking while a taxi device keeps the page open. Clicking a taxi row or its **GPS** action selects that taxi, centers the map on its latest coordinates, and opens its location popup. Locations are stored in the browser under `taxiLocations`.

In static-only mode, the app cannot read a closed or remote taxi device in the background. With the shared API, authenticated drivers can explicitly share one GPS position or live GPS updates; the server records the latest position and audit event. A production deployment should still define GPS retention and device-management policies.

## Driver database and documents

The Drivers page maintains a browser-based driver database under the `driverDatabase` local-storage key. Each record includes identity details, residence, 14-digit National ID (NIN), date of birth, nationality, contact details, next-of-kin details, assigned taxi ID and plate, and repeatable document-register rows.

Supported Ugandan plate examples include old private format `UAA001A` and new/digital private format `UA001AA`; spaces are removed while entering a plate. The assigned taxi is linked by its stable taxi ID, so the driver profile can also show the taxi's latest GPS coordinates, accuracy, update time, and active/inactive status.

The driver portal uses the language selected at sign-in or stored on the driver account. English, French, Arabic, Portuguese, Hindi, Swahili, Luganda, Runyankole, Acholi, Ateso, Somali, Lugbara, Rukiga, Runyoro, Sango, and Lango are listed. Translated labels and messages use the selected language; phrases without a maintained translation fall back to English.

The driver portal opens directly to the **What do you need to do?** menu. It has no overview, profile editor, password editor, duplicate summary cards, or repeated account data in the main flow. The account icon opens a read-only summary only. A local illustrated instruction slideshow rotates automatically and can also be controlled with the left/right arrows, dot controls, keyboard arrows, or touch swipes; each action card also includes a matching visual thumbnail. Choose **Record a trip** to enter a trip, **Fuel** for a fill-up, or **Expenses & maintenance** for service or faults; only the selected view is visible at a time. Drafts save automatically in the current browser and synchronize to the API when it is enabled. A submitted report is written to the shared `trips`, `fuelRecords`, or `maintenanceRecords` collection with the driver's identity and assigned taxi, so the administrator sees it on the relevant dashboard pages, collections, Records, and CSV exports. Trip, fuel, and maintenance records submitted by the driver can be edited by that driver until they are replaced by a new submission.

The driver forms use the same integrations as the administrator workspace: Google Places/Map search for Uganda pickup/drop-off points, fuel stations, and service providers; Google Routes/OpenStreetMap fallback for distance; the Uganda fuel-price catalog for suggested pump rates; and the optional Google Cloud Translation proxy for localized interface text. Driver records never send passenger names or document files to these services. When the shared API is enabled, collections, GPS reports, account preferences, and encrypted document metadata/files are synchronized through authenticated server endpoints; otherwise the UI falls back to localStorage.

### Optional Google-assisted natural translations

The repository includes a small server-side Google Cloud Translation proxy. It translates only the interface phrases, keeps the Google API key out of the browser, and falls back to the built-in language packs when Google is unavailable. Driver names, NINs, addresses, GPS coordinates, and document files are never sent to the translation proxy.

1. Enable the **Cloud Translation API** in a Google Cloud project and enable billing.
2. Create a separate restricted server-side API key with Translation API permission; the Google Maps browser key is not reused for translation.
3. Start the services with the key supplied only to the proxy:

```bash
cp .env.example .env
# edit .env and set GOOGLE_TRANSLATE_API_KEY
docker compose up --build -d
```

If the Compose plugin is unavailable, run the same two services with plain Docker:

```bash
cp .env.example .env
# edit .env and set GOOGLE_TRANSLATE_API_KEY
docker network create mama-africa-net
docker build -t mama-africa-translation-proxy:local translation-service
docker run -d --name mama-africa-translation-api --network mama-africa-net --network-alias translation-api --env-file .env --read-only --tmpfs /tmp --security-opt no-new-privileges:true --restart unless-stopped mama-africa-translation-proxy:local
docker build -t mama-africa-transport:latest .
docker run -d --name mama-africa-transport --network mama-africa-net -p 8080:80 --restart unless-stopped mama-africa-transport:latest
```

If the network or containers already exist, remove them with `docker rm -f mama-africa-transport mama-africa-translation-api` and `docker network rm mama-africa-net` before retrying. Never put the translation key in `index.html` or commit it to Git. If no key is supplied, the dashboard remains fully usable with the saved offline translations. Google may not support every Ugandan language; unsupported phrases automatically use the curated English or local fallback.

The document register stores document type, number, issuing authority, expiry date, verification status, and a file name or secure reference. With the shared API, administrators can upload PDF/image files up to 8 MB; record payloads and files are encrypted at rest with AES-256-GCM and served only after server-side authorization. Static-only mode still stores references only.

The shared API now supplies server-side sessions, role enforcement, persistent SQLite storage, encrypted document files, GPS consent checks, and audit logs. A production deployment still needs HTTPS, a strong secret-management process, database backups, monitoring, CI/CD, and a larger managed database when SQLite is no longer sufficient.
