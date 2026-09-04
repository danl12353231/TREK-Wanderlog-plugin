# Wanderlog Import

## What it does

A [TREK](https://github.com/liketrek/TREK) page plugin that imports a trip from
[Wanderlog](https://wanderlog.com) into TREK as a new trip owned by the current
user. Paste a Wanderlog **share/view URL** (or a bare trip key) and the plugin
recreates:

- trip title, start/end dates, and currency (from the Wanderlog budget)
- the day-by-day itinerary (days matched to their dates)
- places with coordinates, formatted addresses, websites, phone numbers, Google
  place ids, and best-effort categories
- note blocks as day notes
- flights (as pending TREK flight reservations with from/to airports)
- hotel stays (as TREK accommodations with check-in/out)

The plugin page shows **live progress** while importing — it writes per-step
counters (days, places, notes, flights) to a job row in its own DB, and the
sandboxed page polls `GET /progress?job=` to render a progress bar and stats as
the import runs.

Wanderlog has no official API, so the plugin reads Wanderlog's public JSON
endpoint (the one Wanderlog's own web app uses) by trip key:

```
GET https://wanderlog.com/api/tripPlans/{key}?clientSchemaVersion=2
```

The trip must be **public or shared** (private trips can't be fetched
anonymously). Because the endpoint is unofficial, the importer is defensive —
unknown or missing fields are skipped rather than failing the whole import, and
a summary of what was imported is shown after each run. Re-importing the same key
returns the previously created trip instead of duplicating it.

## Compatibility

Supports TREK **3.4.0+**, including the 4.x line (manifest `"trek": ">=3.4.0 <5.0.0"`).
No host code or client bridge changes were needed for 4.x — the plugin uses the
stable `ctx` RPC surface, `definePlugin` routes and the `window.trek` frame bridge.

## Screenshots

<img width="3010" height="744" alt="image" src="https://github.com/user-attachments/assets/ccbd1788-f1c0-4fea-9808-25bd381b8406" />
<img width="1411" height="583" alt="image" src="https://github.com/user-attachments/assets/b75aebd0-10a3-4c39-b648-bcca92c34a4e" />


## Setup

1. Validate and build the plugin:

   ```sh
   npx trek-plugin-sdk validate
   npx trek-plugin-sdk pack
   ```

2. Extract `plugin.zip` into TREK's plugin directory on the server, under a
   folder named after the plugin id:

   ```
   <TREK data dir>/plugins/wanderlog-import/{trek-plugin.json, server/, client/}
   ```

   For the official Docker image the data dir is `/app/data`, i.e.
   `/app/data/plugins/wanderlog-import/`. Then trigger a plugin rescan or restart
   TREK.

3. The **Wanderlog Import** page appears in the TREK navbar at
   `/plugins/wanderlog-import`. Open a trip in Wanderlog → **Share** → copy the
   link (e.g. `https://wanderlog.com/plan/abc123xyz/my-trip/shared`) and paste it
   into the page, then click **Import**.

## Permissions

| Permission | Why |
|---|---|
| `http:outbound:wanderlog.com` | fetch the trip JSON from Wanderlog |
| `db:create:trips` | create the new trip |
| `db:write:trips` | write trip metadata |
| `db:write:days` | create/set days from itinerary sections |
| `db:write:places` | create the imported places |
| `db:write:itinerary` | assign places to days |
| `db:write:daynotes` | import note blocks as day notes |
| `db:write:accommodations` | import hotel stays |
| `db:write:reservations` | import flights as reservations |
| `db:read:trips` | map days by date after trip creation |
| `db:read:categories` | best-effort place category mapping |
| `db:own` | store a key→trip mapping for de-duplication |
| `db:meta` | create and migrate the plugin's own progress-tracking tables (`imports`, `jobs`) |

## Development

```sh
npx trek-plugin-sdk dev        # live reload at http://localhost:4317
npx trek-plugin-sdk status     # registry-readiness checklist
npx trek-plugin-sdk pack       # build plugin.zip
npx trek-plugin-sdk shot       # regenerate docs/screenshot.png (needs Playwright)
```

## License

MIT
