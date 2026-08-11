// End-to-end test: run the plugin's /import + /continue routes against the REAL
// Wanderlog API. ctx.db (job/import state) is backed by a real in-memory SQLite so
// the chunked, cross-request import flow is exercised faithfully.
'use strict';
const path = require('path');
const assert = require('assert');
const Database = require('better-sqlite3');
const { createMockHost } = require('trek-plugin-sdk/testing');

const PLUGIN = path.resolve('/plugin');
const def = require(path.join(PLUGIN, 'server', 'index.js'));

const GRANTS = [
  'db:own', 'db:read:trips', 'db:read:categories', 'db:create:trips', 'db:write:trips',
  'db:write:days', 'db:write:places', 'db:write:itinerary', 'db:write:daynotes',
  'db:write:accommodations', 'db:write:reservations', 'db:read:daynotes', 'http:outbound:wanderlog.com',
];

// Replace the mock's (recorder) ctx.db with a real in-memory SQLite so jobs and
// the imports mapping actually persist across /import → /continue calls.
function withRealDb(mock) {
  const realDb = new Database(':memory:');
  const applied = new Set();
  const shim = {
    async query(sql, ...args) { return realDb.prepare(sql).all(...args); },
    async exec(sql, ...args) { return { changes: realDb.prepare(sql).run(...args).changes }; },
    async migrate(id, sql) { if (!applied.has(id)) { realDb.exec(sql); applied.add(id); } return { applied: true }; },
    _db: realDb,
  };
  mock.ctx.db = shim;
  return shim;
}

function makeReq(method, path, body, query) {
  return {
    method, path,
    query: query || {}, headers: {}, rawBodyBase64: null,
    body: body ?? null,
    user: { id: 1, username: 'u', isAdmin: false },
  };
}

function newMock(extraOpts) {
  const mock = createMockHost({ grants: GRANTS, actingUserId: 1, users: { 1: { id: 1 } }, ...(extraOpts || {}) });
  withRealDb(mock);
  return mock;
}

async function importTrip(key, job, mock) {
  mock = mock || newMock();
  const { ctx } = mock;
  await def.onLoad(ctx);
  const route = (p) => def.routes.find((r) => r.path === p);

  const start = await route('/import').handler(makeReq('POST', '/import', { url: key, job }), ctx);
  const startBody = JSON.parse(start.body);
  if (!startBody.ok) throw new Error(`import start failed: ${startBody.message}`);

  let last = null;
  let guard = 0;
  while (guard++ < 300) {
    const c = await route('/continue').handler(makeReq('POST', '/continue', { job }), ctx);
    const body = JSON.parse(c.body);
    if (!body.ok) throw new Error(`import continue failed: ${body.message}`);
    last = body;
    if (body.done) break;
  }
  if (!last || !last.done) throw new Error('import did not finish');
  return { body: last, ctx, mock };
}

(async () => {
  const china = 'https://wanderlog.com/plan/fcrtthfrvwkmypzl/trip-to-china/shared';
  const keys = [china, 'vayytsqzpq', 'klfimtiqam'];
  for (const key of keys) {
    console.log('\n===== importing', key, '=====');
    const job = 'imp_test_' + Math.random().toString(36).slice(2, 8);
    const { body, ctx } = await importTrip(key, job);
    console.log('result:', JSON.stringify(body, null, 2));

    const trips = await ctx.trips.listMine();
    assert(trips.length === 1, 'a trip was created');
    const data = trips[0];
    const tripId = Number(data.id);
    const days = await ctx.trips.getDays(tripId);
    const places = await ctx.trips.getPlaces(tripId);
    const accoms = await ctx.trips.getAccommodations(tripId);
    const reservations = await ctx.reservations.listMine();

    assert(data.title, 'trip has title');
    console.log('created trip title:', data.title, '| days:', days.length,
      '| places:', places.length, '| accommodations:', accoms.length, '| reservations:', reservations.length);
    const notes = [];
    for (const d of days) notes.push(...await ctx.daynotes.list(tripId, Number(d.id)));
    console.log('daynotes:', notes.length);

    if (data.start_date || data.end_date) console.log('dates:', data.start_date, '->', data.end_date);
    const sample = places[0];
    if (sample) {
      console.log('sample place:', JSON.stringify({ name: sample.name, lat: sample.lat, lng: sample.lng, address: sample.address, google_place_id: sample.google_place_id }));
      assert(typeof sample.lat === 'number' && typeof sample.lng === 'number', 'place has coordinates');
    }

    const flights = reservations.filter((r) => r.type === 'flight');
    if (String(key).includes('fcrtthfrvwkmypzl')) {
      assert(flights.length === 2, `expected 2 flights, got ${flights.length}`);
      for (const f of flights) {
        console.log('flight:', JSON.stringify({ title: f.title, endpoints: (f.endpoints || []).map((e) => ({ role: e.role, name: e.name, code: e.code, date: e.local_date, time: e.local_time })) }));
        assert(Array.isArray(f.endpoints) && f.endpoints.length >= 2, 'flight has from/to endpoints');
      }
    }

    const pr = def.routes.find((r) => r.path === '/progress');
    const prRes = await pr.handler(makeReq('GET', '/progress', null, { job }), ctx);
    const prBody = JSON.parse(prRes.body);
    console.log('progress route:', prRes.status, JSON.stringify(prBody));
    assert(prRes.status === 200 && prBody.ok === true, 'progress route answers ok');
  }

  // de-dupe: live mapped trip → short-circuit to duplicate.
  {
    console.log('\n===== de-dupe via existing mapping (trip still exists) =====');
    const mock = newMock({ trips: { 99: { members: [1], data: { id: 99, title: 'Already imported trip' } } } });
    const { ctx } = mock;
    await def.onLoad(ctx); // migrations create the imports table
    const realDb = mock.ctx.db._db;
    realDb.exec("INSERT INTO imports (wanderlog_key, trip_id, imported_at) VALUES ('vayytsqzpq', 99, 'x')");
    const start = await def.routes.find((r) => r.path === '/import')
      .handler(makeReq('POST', '/import', { url: 'vayytsqzpq', job: 'dup_test' }), ctx);
    const body = JSON.parse(start.body);
    console.log('result:', JSON.stringify(body));
    assert(body.ok === true && body.duplicate === true && body.tripId === 99, 'returns existing trip as duplicate');
  }

  // stale mapping: mapped trip deleted → re-imports fresh.
  {
    console.log('\n===== stale mapping (trip deleted) → re-imports =====');
    const mock = newMock();
    const { ctx } = mock;
    await def.onLoad(ctx);
    mock.ctx.db._db.exec("INSERT INTO imports (wanderlog_key, trip_id, imported_at) VALUES ('vayytsqzpq', 777, 'x')");
    const { body } = await importTrip('vayytsqzpq', 'stale_test', mock);
    console.log('result:', JSON.stringify(body));
    assert(body.done === true && body.counts.places > 0, 'stale mapping re-imports instead of duplicating');
    const trips = await ctx.trips.listMine();
    assert(trips.some((t) => Number(t.id) !== 777), 'a fresh trip was created');
  }

  console.log('\nALL OK');
})().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
