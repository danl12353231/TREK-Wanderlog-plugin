// Wanderlog Import — a TREK page plugin.
//
// Given a Wanderlog trip (pasted as a share/view URL or a bare trip key), the
// plugin recreates it in TREK as a new trip owned by the acting user: days,
// places (coords, addresses, websites, categories), notes, flights and hotels.
//
// Timeout-safe design: the TREK web client's axios has an 8s timeout on plugin
// route calls, and a full import issues a few hundred rate-limited ctx.* RPCs.
// So the work is SPLIT across requests:
//   POST /import    — validates + de-dupes, fetches the plan, creates the trip,
//                     persists the job state, returns quickly (tripId + totals).
//   POST /continue  — resumes the job from its persisted cursor and processes a
//                     bounded chunk of blocks (≤ a call budget, well under 8s),
//                     updating progress and the cursor after every block. The
//                     page calls it repeatedly until `done: true`.
//   GET  /progress  — returns the live job row for display.
//
// Data model (from the unofficial but stable public endpoint):
//   GET https://wanderlog.com/api/tripPlans/{key}?clientSchemaVersion=2
//   { success, tripPlan: {
//       key, title, startDate, endDate, privacy, type,
//       itinerary: { sections: [ { id, heading, date, type, mode,
//                                  blocks: [ { type, place, text, hotel, ... } ] } ] },
//       itinerary.budget.amount.currencyCode } }

'use strict';

const { definePlugin } = require('trek-plugin-sdk');

const API_BASE = 'https://wanderlog.com/api/tripPlans';
// How many ctx.* RPCs one /continue call may issue. The TREK web client aborts a
// plugin route call at 8s (axios), and the host forwards our handler's full run to
// that client — so a chunk must finish comfortably inside the window. Budget 18
// keeps a request to a few seconds even from an empty shared rate-limit bucket
// (~24 tokens incl. per-block bookkeeping at 14/sec ≈ 1.7s + RPC latency).
const CHUNK_BUDGET = 18;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object' && Array.isArray(value.ops)) {
    return value.ops.map((op) => (op && typeof op.insert === 'string' ? op.insert : '')).join('').trim();
  }
  return '';
}

function extractKey(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const m = raw.match(/wanderlog\.com\/(?:view|t\/tripPlans|i|plan)\/([A-Za-z0-9_-]{8,40})/i);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{8,40}$/.test(raw)) return raw;
  return null;
}

function normDate(value) {
  if (!value) return null;
  const s = String(value).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function isHotelSection(heading) {
  return /hotel|stay|lodging|accommodat|where to stay|unterkunft/i.test(heading || '');
}

function categoryNameFor(placeTypes, heading) {
  const t = (Array.isArray(placeTypes) ? placeTypes : []).join(' ').toLowerCase();
  const h = (heading || '').toLowerCase();
  const all = `${t} ${h}`;
  if (/hotel|lodging|stay|accommodat|hostel/.test(all)) return 'Hotel';
  if (/restaurant|food|meal_takeaway|cafe|bar|bakery|meal|dining/.test(all)) return 'Restaurant';
  if (/museum|art_gallery|point_of_interest|tourist_attraction|monument|landmark/.test(all)) return 'Sight';
  if (/shopping_mall|store|shop|supermarket/.test(all)) return 'Shopping';
  if (/park|nature|zoo|beach|national_park/.test(all)) return 'Outdoor';
  if (/night_club|bar|entertainment|movie|casino|bowling/.test(all)) return 'Entertainment';
  if (/airport|train_station|transit_station|subway|bus/.test(all)) return 'Transport';
  if (/spa|gym|salon/.test(all)) return 'Wellness';
  return null;
}

function airportOf(station) {
  return (station && station.airport) || null;
}

function endpointOf(role, station, sequence) {
  const ap = station && station.airport;
  const gp = ap && ap.googlePlace;
  return {
    role,
    sequence,
    name: (ap && ap.name) || (ap && ap.cityName) || '',
    code: (ap && ap.iata) || null,
    lat: gp && gp.geometry && gp.geometry.location ? gp.geometry.location.lat : 0,
    lng: gp && gp.geometry && gp.geometry.location ? gp.geometry.location.lng : 0,
    timezone: null,
    local_time: station.time || null,
    local_date: normDate(station.date),
  };
}

async function fetchTrip(key) {
  const url = `${API_BASE}/${encodeURIComponent(key)}?clientSchemaVersion=2`;
  let res;
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'trek-wanderlog-import/1.0' },
    });
  } catch (e) {
    throw new Error(`Could not reach Wanderlog: ${e.message}`);
  }
  if (!res.ok) throw new Error(`Wanderlog returned HTTP ${res.status}`);
  const data = await res.json();
  if (!data || data.success !== true || !data.tripPlan) {
    throw new Error(data && data.error ? `Wanderlog error: ${data.error}` : 'Trip not found or not publicly shared');
  }
  return data.tripPlan;
}

// Pace ctx.* calls below the host's rate limit (burst 60 / 20 per sec) so the
// importer never trips the host-loop DoS guard mid-import.
function makeTokenBucket(capacity, refillPerSec) {
  let tokens = capacity;
  let last = Date.now();
  async function acquire() {
    for (;;) {
      const now = Date.now();
      const elapsedSec = (now - last) / 1000;
      tokens = Math.min(capacity, tokens + elapsedSec * refillPerSec);
      last = now;
      if (tokens >= 1) { tokens -= 1; return; }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  return acquire;
}

// ONE bucket for the whole child process, shared across every route request. The
// host rate-limits a plugin's ctx.* calls per-plugin (burst 60, 20/sec sustained)
// and the bucket persists across requests — so a per-request local bucket lets
// back-to-back /continue calls drain the SHARED host bucket and get throttled.
// A single global bucket (45 burst / 14 per sec) keeps us below the host's
// sustained rate no matter how fast the page fires requests.
const GLOBAL_BUCKET_ACQUIRE = makeTokenBucket(45, 14);

function throttleCtx(ctx) {
  const wrap = (fn) => async (...args) => { await GLOBAL_BUCKET_ACQUIRE(); return fn(...args); };
  const out = {};
  for (const [key, val] of Object.entries(ctx)) {
    if (val && typeof val === 'object') {
      const nested = {};
      for (const [k, v] of Object.entries(val)) {
        if (k === 'log' || k === 'events') { nested[k] = v; continue; }
        nested[k] = typeof v === 'function' ? wrap(v) : v;
      }
      out[key] = nested;
    } else if (typeof val === 'function') {
      out[key] = wrap(val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

function genJobId() {
  return `imp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// In-process guard so two overlapping requests (a browser that timed out and
// retried while the first request is still finishing) never process the same
// cursor chunk twice. All route handlers for one plugin run in the same child
// process, so a Set is a safe lock; the job DB cursor is what makes a dropped
// response resumable without duplicating work.
const ACTIVE_JOBS = new Set();

function busyBody(jobId) {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ok: true, jobId: String(jobId), busy: true }),
  };
}

// ---------------------------------------------------------------------------
// Job persistence (the plugin's own SQLite DB)
// ---------------------------------------------------------------------------

const JOB_COLUMNS = [
  'status', 'step', 'message', 'current_section',
  'total_sections', 'sections_done',
  'total_places', 'places_done',
  'total_notes', 'notes_done',
  'total_flights', 'flights_done',
  'trip_id', 'counts', 'cursor', 'days_by_date', 'cat_by_name', 'plan', 'current_day_id', 'error',
];

async function createJob(ctx, jobId, key) {
  const now = new Date().toISOString();
  await ctx.db.exec(
    'INSERT OR REPLACE INTO import_jobs (id, wanderlog_key, status, step, message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    jobId, key, 'running', 'start', 'Connecting to Wanderlog…', now, now,
  );
}

async function updateJob(ctx, jobId, patch) {
  const entries = JOB_COLUMNS.filter((c) => patch[c] !== undefined).map((c) => [c, patch[c]]);
  if (entries.length === 0) return;
  const sets = entries.map(([c]) => `${c} = ?`).join(', ');
  await ctx.db.exec(
    `UPDATE import_jobs SET ${sets}, updated_at = ? WHERE id = ?`,
    ...entries.map(([, v]) => v),
    new Date().toISOString(),
    jobId,
  );
}

async function loadJob(ctx, jobId) {
  const rows = await ctx.db.query('SELECT * FROM import_jobs WHERE id = ?', jobId);
  return rows[0] || null;
}

function computeTotals(sections) {
  const t = { sections: sections.length, places: 0, notes: 0, flights: 0 };
  for (const s of sections) {
    for (const b of s.blocks || []) {
      if (b.type === 'place' && b.place && b.place.name) t.places++;
      else if (b.type === 'note' && textOf(b.text)) t.notes++;
      else if (b.type === 'flight') t.flights++;
    }
  }
  return t;
}

// ---------------------------------------------------------------------------
// Block importers (one block = a bounded unit of work; each saves cursor +
// counts back to the job so /continue is resumable and never duplicates)
// ---------------------------------------------------------------------------

// Ensure the section's TREK day exists; returns its id.
async function dayForSection(ctx, tripId, section, daysByDate) {
  const dt = normDate(section.date);
  if (dt && daysByDate.has(dt)) {
    const id = daysByDate.get(dt);
    if (section.heading && String(section.heading).trim()) {
      try { await ctx.days.update(tripId, id, { title: String(section.heading).trim() }); } catch (_) {}
    }
    return { id, created: false };
  }
  const day = await ctx.days.create(tripId, { date: dt || undefined });
  const id = Number(day.id);
  if (dt) daysByDate.set(dt, id);
  if (section.heading && String(section.heading).trim()) {
    try { await ctx.days.update(tripId, id, { title: String(section.heading).trim() }); } catch (_) {}
  }
  return { id, created: true };
}

async function importPlace(ctx, tripId, section, block, daysByDate, catByName, dayId, start, end) {
  const wp = block.place;
  if (!wp || !wp.name) return false;
  const placeInput = {
    name: wp.name,
    lat: wp.geometry && wp.geometry.location ? wp.geometry.location.lat : undefined,
    lng: wp.geometry && wp.geometry.location ? wp.geometry.location.lng : undefined,
    address: wp.formatted_address || wp.vicinity || undefined,
    website: wp.website || undefined,
    phone: wp.international_phone_number || undefined,
    google_place_id: wp.place_id || undefined,
    notes: textOf(block.text) || undefined,
  };
  const catName = categoryNameFor(wp.types, section.heading);
  if (catName && catByName.has(catName.toLowerCase())) {
    placeInput.category_id = catByName.get(catName.toLowerCase()).id;
  }
  for (const k of Object.keys(placeInput)) if (placeInput[k] === undefined) delete placeInput[k];

  const place = await ctx.places.create(tripId, placeInput);
  const placeId = Number(place.id);
  await ctx.itinerary.assign(tripId, dayId, placeId, placeInput.notes || null);

  const isHotel = block.hotel || isHotelSection(section.heading);
  if (isHotel) {
    const ci = normDate(block.hotel && block.hotel.checkIn) || normDate(section.date) || start;
    const co = normDate(block.hotel && block.hotel.checkOut) || end;
    try {
      const startDayId = ci ? daysByDate.get(ci) : null;
      const endDayId = co ? daysByDate.get(co) : startDayId;
      if (startDayId && endDayId) {
        await ctx.accommodations.create(tripId, {
          place_id: placeId, start_day_id: startDayId, end_day_id: endDayId,
          check_in: ci, check_out: co,
          confirmation: (block.hotel && block.hotel.confirmationNumber) || undefined,
          notes: placeInput.notes || undefined,
        });
      }
    } catch (_) { /* lodging is best-effort */ }
  }
  return true;
}

async function importFlight(ctx, tripId, block, daysByDate, fallbackDayId) {
  const fi = block.flightInfo || {};
  const airline = fi.airline || {};
  const num = fi.number != null ? String(fi.number) : '';
  const depAp = airportOf(block.depart);
  const arrAp = airportOf(block.arrive);
  const depName = depAp && (depAp.name || depAp.cityName);
  const arrName = arrAp && (arrAp.name || arrAp.cityName);
  const code = [airline.iata || airline.name || '', num].filter(Boolean).join(' ');
  const title = [code, depName && arrName ? `${depName} → ${arrName}` : ''].filter(Boolean).join(' · ') || 'Flight';

  const endpoints = [];
  if (block.depart) endpoints.push(endpointOf('from', block.depart, 0));
  if (block.arrive) endpoints.push(endpointOf('to', block.arrive, 1));

  const departDate = normDate(block.depart && block.depart.date);
  const departTime = block.depart && block.depart.time;
  const dayId = (departDate && daysByDate.get(departDate)) || fallbackDayId || undefined;

  try {
    const reservation = await ctx.reservations.create(tripId, {
      type: 'flight', title, endpoints, day_id: dayId,
      reservation_time: departDate ? (departTime ? `${departDate} ${departTime}` : departDate) : undefined,
      status: 'pending',
    });
    return reservation != null;
  } catch (e) {
    ctx.log.warn(`wanderlog import: flight "${title}" skipped: ${e.message}`);
    return false;
  }
}

// Process one block. Returns the number of ctx.* RPCs consumed.
async function processBlock(ctx, jobId, tripId, section, block, daysByDate, catByName, dayId, counts, start, end) {
  const btype = block.type;

  if (btype === 'flight') {
    if (await importFlight(ctx, tripId, block, daysByDate, dayId)) counts.flights++;
    else counts.skipped++;
    return 2;
  }

  if (btype === 'place') {
    let calls = 3;
    const ok = await importPlace(ctx, tripId, section, block, daysByDate, catByName, dayId, start, end);
    if (!ok) { counts.skipped++; return 1; }
    counts.places++;
    if (block.hotel || isHotelSection(section.heading)) {
      // accommodation.create may have run (best-effort) — count it if it used calls.
      calls += 1;
    }
    return calls;
  }

  if (btype === 'note') {
    const text = textOf(block.text);
    if (!text) { counts.skipped++; return 1; }
    try {
      await ctx.daynotes.create(tripId, dayId, { text });
      counts.notes++;
    } catch (_) { counts.skipped++; }
    return 2;
  }

  counts.skipped++;
  return 1;
}

// ---------------------------------------------------------------------------
// The resumable chunked import
// ---------------------------------------------------------------------------

async function startImport(ctx, key, jobId) {
  // de-dupe (mapping is only trusted while its trip still exists)
  const dup = await ctx.db.query('SELECT trip_id FROM imports WHERE wanderlog_key = ?', key);
  if (dup.length > 0 && dup[0].trip_id) {
    const existingTripId = Number(dup[0].trip_id);
    let existing = null;
    try { existing = await ctx.trips.getById(existingTripId); } catch (_) {}
    if (existing) return { duplicate: true, tripId: existingTripId, jobId };
    try { await ctx.db.exec('DELETE FROM imports WHERE wanderlog_key = ?', key); } catch (_) {}
  }

  // A previous interrupted run for the same key? Resume its job instead of
  // creating a second trip — but only if the trip it created still exists.
  const running = await ctx.db.query(
    "SELECT id FROM import_jobs WHERE wanderlog_key = ? AND status = 'running' AND trip_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
    key,
  );
  if (running.length > 0) {
    const job = await loadJob(ctx, String(running[0].id));
    if (job) {
      let stillExists = false;
      try { stillExists = !!(await ctx.trips.getById(Number(job.trip_id))); } catch (_) {}
      if (stillExists) {
        return {
          ok: true, jobId: String(running[0].id), tripId: Number(job.trip_id),
          totals: { sections: job.total_sections || 0, places: job.total_places || 0, notes: job.total_notes || 0, flights: job.total_flights || 0 },
        };
      }
    }
  }

  await createJob(ctx, jobId, key);
  await updateJob(ctx, jobId, { step: 'fetch', message: 'Fetching trip from Wanderlog…' });
  const plan = await fetchTrip(key);

  const sections = (plan.itinerary && plan.itinerary.sections) || [];
  const totals = computeTotals(sections);
  await updateJob(ctx, jobId, {
    step: 'create',
    message: `"${plan.title || 'Trip'}" found — creating TREK trip…`,
    total_sections: totals.sections, total_places: totals.places,
    total_notes: totals.notes, total_flights: totals.flights,
  });

  const title = plan.title || 'Imported trip';
  const start = normDate(plan.startDate);
  const end = normDate(plan.endDate);
  const currency = plan.itinerary && plan.itinerary.budget && plan.itinerary.budget.amount
    ? plan.itinerary.budget.amount.currencyCode : undefined;
  const description = [
    `Imported from Wanderlog (https://wanderlog.com/view/${key}).`,
    plan.type ? `Wanderlog type: ${plan.type}.` : '',
    plan.privacy ? `Privacy: ${plan.privacy}.` : '',
  ].filter(Boolean).join(' ');

  const trip = await ctx.trips.create({
    title, description,
    start_date: start || undefined, end_date: end || undefined,
    currency: /^[A-Z]{3}$/.test(currency || '') ? currency : undefined,
  });
  const tripId = Number(trip.id);

  let categories = [];
  try { categories = (await ctx.categories.list()) || []; } catch (_) {}
  const catByName = new Map(categories.filter((c) => c && c.name).map((c) => [String(c.name).toLowerCase(), c]));

  const daysByDate = new Map();
  try {
    const existing = (await ctx.trips.getDays(tripId)) || [];
    for (const d of existing) { const dt = normDate(d.date); if (dt) daysByDate.set(dt, Number(d.id)); }
  } catch (_) {}

  await updateJob(ctx, jobId, {
    trip_id: tripId,
    step: 'importing',
    message: 'Importing…',
    cursor: JSON.stringify({ sectionIndex: 0, blockIndex: 0 }),
    days_by_date: JSON.stringify(Array.from(daysByDate.entries())),
    cat_by_name: JSON.stringify(Array.from(catByName.entries())),
    plan: JSON.stringify(plan),
  });

  return { ok: true, jobId, tripId, totals };
}

// Process up to CHUNK_BUDGET ctx calls of the job; returns the new state.
async function continueImport(rawCtx, jobId) {
  const job = await loadJob(rawCtx, jobId);
  if (!job) throw new Error('Import job not found — it may have expired.');
  if (job.status === 'done') return finalResult(job);
  if (job.status === 'error') return { ok: true, jobId, done: true, error: job.error || 'Import failed', counts: parseCounts(job.counts) };

  const ctx = throttleCtx(rawCtx);
  const plan = JSON.parse(job.plan || 'null') || {};
  const sections = (plan.itinerary && plan.itinerary.sections) || [];
  const cursor = JSON.parse(job.cursor || '{"sectionIndex":0,"blockIndex":0}');
  const daysByDate = new Map(JSON.parse(job.days_by_date || '[]'));
  const catByName = new Map(JSON.parse(job.cat_by_name || '[]'));
  const counts = parseCounts(job.counts);
  const start = normDate(plan.startDate);
  const end = normDate(plan.endDate);
  const tripId = Number(job.trip_id);
  const totals = {
    sections: job.total_sections || 0, places: job.total_places || 0,
    notes: job.total_notes || 0, flights: job.total_flights || 0,
  };

  let calls = 0;
  let currentDayId = job.current_day_id ? Number(job.current_day_id) : null;
  while (calls < CHUNK_BUDGET) {
    const section = sections[cursor.sectionIndex];
    if (!section) break; // all sections done
    const blocks = section.blocks || [];

    // Empty section — skip.
    if (blocks.length === 0) {
      cursor.sectionIndex++;
      cursor.blockIndex = 0;
      continue;
    }

    // Flights-only section — no day needed.
    const flightBlocks = blocks.filter((b) => b.type === 'flight');
    const nonFlight = blocks.filter((b) => b.type !== 'flight');
    const isFlightsOnly = flightBlocks.length > 0 && nonFlight.length === 0;

    // First block of a normal section: ensure its day exists.
    if (cursor.blockIndex === 0 && !isFlightsOnly) {
      const label = String(section.heading || '').trim() || (section.date ? `Day ${counts.sections + 1}` : '');
      await updateJob(ctx, jobId, {
        current_section: label || `Day ${counts.sections + 1}`,
        message: label ? `Importing — ${label}` : `Importing day ${counts.sections + 1}`,
      });
      const day = await dayForSection(ctx, tripId, section, daysByDate);
      currentDayId = day.id;
      counts.sections++;
      calls += day.created ? 2 : 1;
      await updateJob(ctx, jobId, {
        cursor: JSON.stringify(cursor), counts: JSON.stringify(counts),
        sections_done: counts.sections, days_by_date: JSON.stringify(Array.from(daysByDate.entries())),
        current_day_id: currentDayId,
      });
      if (calls >= CHUNK_BUDGET) break;
    }

    if (isFlightsOnly) {
      const block = blocks[cursor.blockIndex];
      calls += await processBlock(ctx, jobId, tripId, section, block, daysByDate, catByName, null, counts, start, end);
      currentDayId = null;
      cursor.blockIndex++;
      if (cursor.blockIndex >= blocks.length) { cursor.sectionIndex++; cursor.blockIndex = 0; }
      await persistProgress(ctx, jobId, cursor, counts, currentDayId);
      continue;
    }

    // Normal section: process blocks[blockIndex..]
    while (cursor.blockIndex < blocks.length && calls < CHUNK_BUDGET) {
      const block = blocks[cursor.blockIndex];
      calls += await processBlock(ctx, jobId, tripId, section, block, daysByDate, catByName, currentDayId, counts, start, end);
      cursor.blockIndex++;
      await persistProgress(ctx, jobId, cursor, counts, currentDayId);
    }
    if (cursor.blockIndex >= blocks.length) {
      cursor.sectionIndex++;
      cursor.blockIndex = 0;
      currentDayId = null;
      await persistProgress(ctx, jobId, cursor, counts, currentDayId);
    }
  }

  const done = cursor.sectionIndex >= sections.length;

  if (done) {
    // remember the mapping for de-dupe (upsert)
    try {
      await ctx.db.exec(
        `INSERT INTO imports (wanderlog_key, trip_id, imported_at) VALUES (?, ?, ?)
         ON CONFLICT(wanderlog_key) DO UPDATE SET trip_id = excluded.trip_id, imported_at = excluded.imported_at`,
        job.wanderlog_key, tripId, new Date().toISOString(),
      );
    } catch (_) {}
    await updateJob(ctx, jobId, {
      status: 'done', step: 'done', message: 'Import complete',
      counts: JSON.stringify(counts), cursor: JSON.stringify(cursor),
      sections_done: counts.sections, places_done: counts.places,
      notes_done: counts.notes, flights_done: counts.flights,
    });
    return { ok: true, jobId, done: true, tripId, counts, totals };
  }

  return { ok: true, jobId, done: false, tripId, counts, totals };
}

async function persistProgress(ctx, jobId, cursor, counts, currentDayId) {
  await updateJob(ctx, jobId, {
    cursor: JSON.stringify(cursor), counts: JSON.stringify(counts),
    sections_done: counts.sections, places_done: counts.places,
    notes_done: counts.notes, flights_done: counts.flights,
    ...(currentDayId != null ? { current_day_id: currentDayId } : { current_day_id: null }),
  }).catch(() => {});
}

function parseCounts(raw) {
  const c = (() => { try { return JSON.parse(raw || '{}'); } catch { return {}; } })();
  return {
    sections: c.sections || 0, places: c.places || 0, notes: c.notes || 0,
    hotels: c.hotels || 0, flights: c.flights || 0, skipped: c.skipped || 0,
  };
}

function finalResult(job) {
  return {
    ok: true, jobId: job.id, done: true, tripId: Number(job.trip_id),
    counts: parseCounts(job.counts),
    totals: {
      sections: job.total_sections || 0, places: job.total_places || 0,
      notes: job.total_notes || 0, flights: job.total_flights || 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

module.exports = definePlugin({
  onLoad: async (ctx) => {
    await ctx.db.migrate(
      '001',
      'CREATE TABLE IF NOT EXISTS imports (wanderlog_key TEXT PRIMARY KEY, trip_id INTEGER NOT NULL, imported_at TEXT NOT NULL)',
    );
    await ctx.db.migrate(
      '002',
      `CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        wanderlog_key TEXT, status TEXT NOT NULL, step TEXT, message TEXT, current_section TEXT,
        total_sections INTEGER DEFAULT 0, sections_done INTEGER DEFAULT 0,
        total_places INTEGER DEFAULT 0, places_done INTEGER DEFAULT 0,
        total_notes INTEGER DEFAULT 0, notes_done INTEGER DEFAULT 0,
        total_flights INTEGER DEFAULT 0, flights_done INTEGER DEFAULT 0,
        trip_id INTEGER, counts TEXT, error TEXT, created_at TEXT, updated_at TEXT
      )`,
    );
    await ctx.db.migrate(
      '003',
      `CREATE TABLE IF NOT EXISTS import_jobs (
        id TEXT PRIMARY KEY,
        wanderlog_key TEXT, status TEXT NOT NULL, step TEXT, message TEXT, current_section TEXT,
        total_sections INTEGER DEFAULT 0, sections_done INTEGER DEFAULT 0,
        total_places INTEGER DEFAULT 0, places_done INTEGER DEFAULT 0,
        total_notes INTEGER DEFAULT 0, notes_done INTEGER DEFAULT 0,
        total_flights INTEGER DEFAULT 0, flights_done INTEGER DEFAULT 0,
        trip_id INTEGER, counts TEXT, cursor TEXT, days_by_date TEXT, cat_by_name TEXT, plan TEXT,
        current_day_id INTEGER, error TEXT, created_at TEXT, updated_at TEXT
      )`,
    );
  },

  routes: [
    {
      method: 'POST',
      path: '/import',
      auth: true,
      async handler(req, ctx) {
        const json = { 'content-type': 'application/json' };
        const fail = (status, message) => ({ status, headers: json, body: JSON.stringify({ ok: false, message }) });

        const input = (req.body && typeof req.body === 'object' ? req.body : {}) || {};
        const key = extractKey(input.url || input.key);
        if (!key) {
          return fail(400, 'Paste a Wanderlog view/plan URL or a trip key (e.g. https://wanderlog.com/plan/abc123xyz/my-trip/shared).');
        }
        const jobId = String(input.job || genJobId());
        if (ACTIVE_JOBS.has(jobId)) return busyBody(jobId);
        ACTIVE_JOBS.add(jobId);
        try {
          const result = await startImport(ctx, key, jobId);
          return { status: 200, headers: json, body: JSON.stringify({ ok: true, jobId, ...result }) };
        } catch (e) {
          ctx.log.warn(`wanderlog import failed for ${key}: ${e.message}`);
          await updateJob(ctx, jobId, { status: 'error', step: 'error', message: e.message, error: String(e.message) }).catch(() => {});
          return fail(422, e.message);
        } finally {
          ACTIVE_JOBS.delete(jobId);
        }
      },
    },
    {
      method: 'POST',
      path: '/continue',
      auth: true,
      async handler(req, ctx) {
        const json = { 'content-type': 'application/json' };
        const fail = (status, message) => ({ status, headers: json, body: JSON.stringify({ ok: false, message }) });
        const input = (req.body && typeof req.body === 'object' ? req.body : {}) || {};
        const jobId = String(input.job || '');
        if (!jobId) return fail(400, 'job is required');
        if (ACTIVE_JOBS.has(jobId)) return busyBody(jobId);
        ACTIVE_JOBS.add(jobId);
        try {
          const result = await continueImport(ctx, jobId);
          return { status: 200, headers: json, body: JSON.stringify({ ok: true, ...result }) };
        } catch (e) {
          ctx.log.warn(`wanderlog import continue failed (${jobId}): ${e.message}`);
          return fail(422, e.message);
        } finally {
          ACTIVE_JOBS.delete(jobId);
        }
      },
    },
    {
      method: 'GET',
      path: '/progress',
      auth: true,
      async handler(req, ctx) {
        const json = { 'content-type': 'application/json' };
        const job = String(req.query.job || '');
        if (!job) return { status: 400, headers: json, body: JSON.stringify({ ok: false, message: 'job is required' }) };
        try {
          const row = await loadJob(ctx, job);
          return { status: 200, headers: json, body: JSON.stringify({ ok: true, job: row }) };
        } catch (e) {
          return { status: 200, headers: json, body: JSON.stringify({ ok: true, job: null }) };
        }
      },
    },
  ],
});
