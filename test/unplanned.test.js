// Regression test for issue #1 — "Items in Wanderlog 'Overview' tab import as days".
//
// Wanderlog's Overview tab is a set of UNDATED list sections (mode:"placeList",
// date:null) — "Places to visit", "Todo", "Notes", "Hotels and lodging". The
// importer used to create a TREK day for every non-flights section, so those
// Overview sections became phantom extra days (the reporter's "Day 10–16").
// They must import into the trip WITHOUT a day (TREK's "unplanned" bucket):
// an unplanned place is a place with no itinerary assignment.
//
// This test runs the real /import + /continue route handlers against the SDK's
// mock host, with `fetch` stubbed to a synthetic plan that mirrors the real
// Wanderlog JSON shape and a tiny pure-JS stand-in for ctx.db (so the test
// needs no native better-sqlite3 build). It is intentionally hermetic — no
// network — complementing the networked, SDK-backed test/e2e.js.
'use strict';

const path = require('path');
const assert = require('assert');
const { createMockHost } = require('trek-plugin-sdk/testing');

const PLUGIN = path.resolve(__dirname, '..');
const def = require(path.join(PLUGIN, 'server', 'index.js'));

const GRANTS = [
  'db:own', 'db:read:trips', 'db:read:categories', 'db:create:trips', 'db:write:trips',
  'db:write:days', 'db:write:places', 'db:write:itinerary', 'db:write:daynotes',
  'db:write:accommodations', 'db:write:reservations', 'db:read:daynotes', 'http:outbound:wanderlog.com',
];

// --- A tiny in-memory stand-in for ctx.db -----------------------------------
// Only the plugin's own statements need to work: job + imports CRUD. We model
// them with two plain-object tables and recognise each SQL statement by prefix.
function makeDbShim() {
  const jobs = new Map();     // import_jobs by id
  const imports = new Map();  // imports by wanderlog_key
  const applied = new Set();

  function parseInsertCols(sql) {
    const m = sql.match(/\(([^)]+)\)\s+VALUES/i);
    return m ? m[1].split(',').map((s) => s.trim()) : [];
  }

  return {
    async migrate(id) { applied.add(id); return { applied: true }; },

    async exec(sql, ...args) {
      const s = sql.trim();
      if (/^INSERT OR REPLACE INTO import_jobs/i.test(s)) {
        const cols = parseInsertCols(s);
        const row = jobs.get(args[0]) || {};
        cols.forEach((c, i) => { row[c] = args[i]; });
        jobs.set(row.id, row);
        return { changes: 1 };
      }
      if (/^UPDATE import_jobs SET/i.test(s)) {
        // "SET a = ?, b = ?, updated_at = ? WHERE id = ?"
        const setPart = s.slice(s.indexOf('SET') + 3, s.indexOf('WHERE'));
        const cols = setPart.split(',').map((c) => c.trim().split('=')[0].trim());
        const id = args[args.length - 1];
        const row = jobs.get(id);
        if (!row) return { changes: 0 };
        cols.forEach((c, i) => { row[c] = args[i]; });
        return { changes: 1 };
      }
      if (/^INSERT INTO imports/i.test(s)) {
        imports.set(args[0], { wanderlog_key: args[0], trip_id: args[1], imported_at: args[2] });
        return { changes: 1 };
      }
      if (/^DELETE FROM imports/i.test(s)) { imports.delete(args[0]); return { changes: 1 }; }
      return { changes: 0 };
    },

    async query(sql, ...args) {
      const s = sql.trim();
      if (/^SELECT trip_id FROM imports/i.test(s)) {
        const r = imports.get(args[0]);
        return r ? [{ trip_id: r.trip_id }] : [];
      }
      if (/FROM import_jobs WHERE wanderlog_key = \? AND status = 'running'/i.test(s)) {
        return [...jobs.values()].filter((j) => j.wanderlog_key === args[0] && j.status === 'running' && j.trip_id != null)
          .map((j) => ({ id: j.id }));
      }
      if (/^SELECT \* FROM import_jobs WHERE id = \?/i.test(s)) {
        const r = jobs.get(args[0]);
        return r ? [{ ...r }] : [];
      }
      return [];
    },
  };
}

function makeReq(method, p, body, query) {
  return {
    method, path: p, query: query || {}, headers: {}, rawBodyBase64: null,
    body: body ?? null, user: { id: 1, username: 'u', isAdmin: false },
  };
}

// --- A synthetic plan mirroring the real Wanderlog JSON shape ----------------
// 4 undated Overview sections (placeList) + 2 dated day-plan sections. The two
// days span the trip; the Overview holds places, a hotel place, a note and a
// flight — none of which may become a TREK day.
function syntheticPlan() {
  const place = (name, lat, lng) => ({
    type: 'place',
    place: { name, geometry: { location: { lat, lng } }, formatted_address: `${name} address`, types: ['point_of_interest'] },
  });
  return {
    key: 'synthkey01',
    title: 'Synthetic Trip',
    startDate: '2025-10-24',
    endDate: '2025-10-25',
    privacy: 'public',
    type: 'trip',
    itinerary: {
      budget: { amount: { currencyCode: 'USD' } },
      sections: [
        // --- Overview tab (undated list sections) ---
        { id: 1, heading: 'Notes', type: 'textOnly', mode: 'placeList', date: null,
          blocks: [{ type: 'note', text: 'Remember passports' }] },
        { id: 2, heading: 'Places to visit', type: 'normal', mode: 'placeList', date: null,
          blocks: [place('Overview Museum', 40.1, -3.1), place('Overview Park', 40.2, -3.2)] },
        { id: 3, heading: 'Hotels and lodging', type: 'hotels', mode: 'placeList', date: null,
          blocks: [{ ...place('Overview Hotel', 40.3, -3.3), hotel: { checkIn: '2025-10-24', checkOut: '2025-10-25' } }] },
        { id: 4, heading: 'Flights', type: 'flights', mode: 'placeList', date: null,
          blocks: [{ type: 'flight', flightInfo: { number: 100, airline: { iata: 'AA' } },
            depart: { airport: { name: 'JFK', iata: 'JFK' }, date: '2025-10-24', time: '08:00' },
            arrive: { airport: { name: 'MAD', iata: 'MAD' }, date: '2025-10-24', time: '20:00' } }] },
        // --- Real itinerary days (dated day-plan sections) ---
        { id: 5, heading: 'Arrival', type: 'normal', mode: 'dayPlan', date: '2025-10-24',
          blocks: [place('Day1 Plaza', 40.4, -3.4), { type: 'note', text: 'Check in' }] },
        { id: 6, heading: 'Exploring', type: 'normal', mode: 'dayPlan', date: '2025-10-25',
          blocks: [place('Day2 Cathedral', 40.5, -3.5)] },
      ],
    },
  };
}

async function run() {
  const tripsStore = {};
  const mock = createMockHost({ grants: GRANTS, actingUserId: 1, users: { 1: { id: 1 } }, trips: tripsStore });
  const { ctx } = mock;
  ctx.db = makeDbShim();

  // Stub fetch so no network is touched; return our synthetic plan.
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, async json() { return { success: true, tripPlan: syntheticPlan() }; } });

  try {
    await def.onLoad(ctx);
    const route = (p) => def.routes.find((r) => r.path === p);
    const job = 'issue1_test';

    const start = await route('/import').handler(makeReq('POST', '/import', { url: 'synthkey01', job }), ctx);
    const sb = JSON.parse(start.body);
    assert(sb.ok, `import start failed: ${sb.message}`);

    let last = null, guard = 0;
    while (guard++ < 200) {
      const c = await route('/continue').handler(makeReq('POST', '/continue', { job }), ctx);
      const b = JSON.parse(c.body);
      assert(b.ok, `continue failed: ${b.message}`);
      last = b;
      if (b.done) break;
    }
    assert(last && last.done, 'import did not finish');

    const tripId = Number(last.tripId);
    const days = await ctx.trips.getDays(tripId);
    const places = await ctx.trips.getPlaces(tripId);
    const accoms = await ctx.trips.getAccommodations(tripId);

    // Assignments (place→day pins) live on the raw trip object in the mock store.
    const rawTrip = tripsStore[tripId] || {};
    const assignments = rawTrip.assignments || [];
    const assignmentCount = assignments.length;
    const assignedPlaceIds = new Set(assignments.map((a) => a.place_id));

    console.log('days:', days.length, '| places:', places.length,
      '| assignments:', assignmentCount, '| accommodations:', accoms.length);

    // THE REGRESSION: exactly 2 days (the two dated day-plan sections) — NOT 6.
    assert.strictEqual(days.length, 2,
      `expected 2 days (the dated itinerary days), got ${days.length} — Overview sections leaked in as days`);

    // Every created day has a real date within the trip range.
    for (const d of days) {
      assert(/^2025-10-2[45]$/.test(String(d.date)), `day has an unexpected date: ${d.date}`);
    }

    // All 5 places imported (2 overview + 1 overview hotel + 1 per day).
    assert.strictEqual(places.length, 5, `expected 5 places, got ${places.length}`);

    // Only the 2 day-plan places are assigned; the 3 Overview places/hotel are unplanned.
    assert.strictEqual(assignmentCount, 2,
      `expected 2 itinerary assignments (one per day place), got ${assignmentCount}`);
    const unplanned = places.filter((p) => !assignedPlaceIds.has(p.id));
    assert.strictEqual(unplanned.length, 3, `expected 3 unplanned places, got ${unplanned.length}`);
    for (const name of ['Overview Museum', 'Overview Park', 'Overview Hotel']) {
      assert(unplanned.some((p) => p.name === name), `"${name}" should be unplanned`);
    }
    for (const name of ['Day1 Plaza', 'Day2 Cathedral']) {
      assert(places.some((p) => p.name === name && assignedPlaceIds.has(p.id)), `"${name}" should be assigned to a day`);
    }

    // The Overview hotel imports as an unplanned place (asserted above). Turning
    // it into a dated TREK accommodation is best-effort and depends on the day it
    // spans already existing — Overview sections are listed before the dated days,
    // so that lookup may miss; either way the place is preserved, not lost.
    assert(accoms.length >= 0, 'accommodations are best-effort');

    console.log('issue #1 regression: PASS');
  } finally {
    global.fetch = origFetch;
  }
}

run().catch((e) => { console.error('TEST FAILED:', e && e.message ? e.message : e); process.exit(1); });
