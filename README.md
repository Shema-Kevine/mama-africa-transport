# Mama Africa Transport

A role-based transport operations dashboard for managing taxis, drivers, trips, fuel, maintenance, and collections in Uganda. Administrators use the full fleet workspace; drivers use a simplified, privacy-aware portal.

## Administrator and driver access

On a fresh browser profile, the dashboard provisions the requested bootstrap administrator account automatically:

- **Username:** `admin`
- **Password:** `mamaafrica`

This is a hardcoded development credential and is visible in the static client; use it only for a private/demo deployment and replace it with a server-backed authentication flow before production. Existing administrator accounts are not overwritten. After signing in, administrators create and manage driver portal usernames and passwords from the Drivers page. Drivers cannot create or edit their own accounts; they sign in with the details supplied by the administrator.

Passwords are stored as salted SHA-256 hashes in the browser rather than plain text. The driver portal exposes only the signed-in driver's read-only account summary and operational submission forms; the full fleet dashboard and account management remain administrator-only.

The driver portal does not request location on page load. Location data is only attached to a trip when a shared location is already available; a production deployment should provide an explicit, administrator-controlled GPS consent flow.

The administrator can export the driver database as CSV from the Drivers page. The export includes operational driver details and document references, but never includes password hashes or salts.

Administrator sections are connected through the sidebar and the Dashboard quick links. Each section also has a URL hash such as `#trips`, `#fuel`, or `#view-all`, so a page can be bookmarked or opened directly after sign-in.

## Run locally

Serve the directory from a local web server so browser storage and the map APIs work:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Run in Docker

The whole static dashboard can be packaged as a single Nginx container. It includes the HTML, logo, fuel-price feed, health endpoint, caching rules, and security headers.

The simplest option on a machine without the Compose plugin is plain Docker:

```bash
docker build -t mama-africa-transport:latest .
docker run -d --name mama-africa-transport --restart unless-stopped -p 8080:80 mama-africa-transport:latest
```

Open `http://localhost:8080`.

If you run the command again and Docker reports that the container name already exists, remove the old container first:

```bash
docker rm -f mama-africa-transport
```

With the Docker Compose plugin installed, the equivalent command is:

```bash
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

Stop or remove the Compose service with `docker compose down`. The container serves the static site; records and GPS reports remain in each visitor's browser `localStorage`, because this project does not include a server database. For production GPS access, serve the container behind HTTPS and use a shared backend for multi-device reporting.

### Containerized driver dashboard

The driver portal is part of the same production container as the administrator dashboard. After signing in with a driver account, the container provides one focused **What do you need to do?** menu. Selecting **Record a trip**, **Fuel**, or **Expenses & maintenance** opens only that view; the account icon opens a read-only identity summary. The administrator and driver views are role-separated in the same image, so a separate driver container is not required.

```bash
docker build -t mama-africa-transport:latest .
docker run -d --name mama-africa-transport --restart unless-stopped -p 8080:80 mama-africa-transport:latest
```

Open `http://localhost:8080`, sign in with a driver account created by the administrator, and choose an action from the menu. Use the account icon only to view the driver's identity and assigned taxi; account changes are handled by the administrator. The current container is still browser-local: driver-submitted trip, fuel, and maintenance records appear in the administrator workspace when both roles use the same browser origin. Use a shared authenticated backend before deploying separate driver devices.

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

Because this is a static browser application, it cannot read a closed or remote taxi device in the background. Each taxi device must open the site, grant location permission, and report its GPS position. A production multi-device deployment would need a shared authenticated GPS endpoint or backend.

## Driver database and documents

The Drivers page maintains a browser-based driver database under the `driverDatabase` local-storage key. Each record includes identity details, residence, 14-digit National ID (NIN), date of birth, nationality, contact details, next-of-kin details, assigned taxi ID and plate, and repeatable document-register rows.

Supported Ugandan plate examples include old private format `UAA001A` and new/digital private format `UA001AA`; spaces are removed while entering a plate. The assigned taxi is linked by its stable taxi ID, so the driver profile can also show the taxi's latest GPS coordinates, accuracy, update time, and active/inactive status.

The driver portal uses the language selected at sign-in or stored on the driver account. English, French, Arabic, Portuguese, Hindi, Swahili, Luganda, Runyankole, Acholi, Ateso, Somali, Lugbara, Rukiga, Runyoro, Sango, and Lango are listed. Translated labels and messages use the selected language; phrases without a maintained translation fall back to English.

The driver portal opens directly to the **What do you need to do?** menu. It has no overview, profile editor, password editor, duplicate summary cards, location/settings pages, or repeated account data in the main flow. The account icon opens a read-only summary only. Choose **Record a trip** to enter a trip, **Fuel** for a fill-up, or **Expenses & maintenance** for service or faults; only the selected view is visible at a time. Drafts save automatically in the current browser. A submitted report is written to the shared `trips`, `fuelRecords`, or `maintenanceRecords` browser key with the driver's identity and assigned taxi, so the administrator sees it on the relevant dashboard pages, collections, Records, and CSV exports. The trip report can be edited by the driver until it is replaced by a new submission.

The driver forms use the same integrations as the administrator workspace: Google Places/Map search for Uganda pickup/drop-off points, fuel stations, and service providers; Google Routes/OpenStreetMap fallback for distance; the Uganda fuel-price catalog for suggested pump rates; and the optional Google Cloud Translation proxy for localized interface text. Driver records never send passenger names or document files to these services. Stored taxi, driver, account, trip, fuel, and maintenance lists are normalized on load and save so repeated IDs are not displayed or counted twice. Because this build is browser-local, the administrator and driver must use the same browser profile/origin for immediate visibility. A real multi-device driver-to-administrator workflow requires an authenticated server API and database; the current localStorage layer is a demo/same-browser implementation.

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

The document register stores document type, number, issuing authority, expiry date, verification status, and a file name or secure reference. It does not upload or store the actual document file. Driver records are local to the current browser; use a shared authenticated backend and encrypted document storage before using the system as a multi-user production database.

This static build provides role-based UI gates and salted password hashes, but it is not a substitute for server-side authorization. A production deployment should move accounts, sessions, driver records, GPS updates, audit logs, and document storage to an authenticated backend with HTTPS, encryption, backups, and server-enforced permissions.
