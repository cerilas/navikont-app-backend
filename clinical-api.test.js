const test = require('node:test');
const assert = require('node:assert/strict');
const { getClinicalBundle, registerClinicalApi, _test } = require('./clinical-api');

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function createRequest(body = {}, params = {}, headers = {}) {
  return {
    body,
    params,
    user: { userId: 'patient-id' },
    get(name) {
      return headers[name.toLowerCase()] || headers[name] || null;
    },
  };
}

function registerRoutes(pool, getEnrollment = async () => ({
  id: 'enrollment-id',
  app_id: 'app-id',
})) {
  const routes = new Map();
  const app = {
    get(path, ...handlers) {
      routes.set(`GET ${path}`, handlers);
    },
    post(path, ...handlers) {
      routes.set(`POST ${path}`, handlers);
    },
    patch(path, ...handlers) {
      routes.set(`PATCH ${path}`, handlers);
    },
  };
  const authenticate = () => {};
  registerClinicalApi({ app, pool, authenticate, getEnrollment });
  return { routes, authenticate };
}

async function invoke(routes, contract, req) {
  const handlers = routes.get(contract);
  assert.ok(handlers, `Missing route ${contract}`);
  const res = createResponse();
  await handlers.at(-1)(req, res);
  return res;
}

test('registers the complete authenticated patient clinical API', () => {
  const routes = [];
  const app = {
    get(path, ...handlers) {
      routes.push(['GET', path, handlers]);
    },
    post(path, ...handlers) {
      routes.push(['POST', path, handlers]);
    },
    patch(path, ...handlers) {
      routes.push(['PATCH', path, handlers]);
    },
  };
  const authenticate = () => {};

  registerClinicalApi({
    app,
    pool: {},
    authenticate,
    getEnrollment: async () => null,
  });

  const contracts = routes.map(([method, path]) => `${method} ${path}`);
  assert.deepEqual(contracts, [
    'GET /api/patient/clinical-state',
    'POST /api/patient/clinical/assets/:contentId/complete',
    'GET /api/patient/m2/sessions/current',
    'POST /api/patient/m2/sessions/current',
    'POST /api/patient/m2/events',
    'PATCH /api/patient/m2/events/:id',
    'POST /api/patient/m2/submit',
    'GET /api/patient/plan/current',
    'POST /api/patient/teachback/responses',
    'GET /api/patient/m5/records',
    'POST /api/patient/m5/records',
    'GET /api/patient/m6/current',
    'GET /api/patient/m7/current',
    'GET /api/patient/m8/current',
  ]);
  for (const [, , handlers] of routes) {
    assert.equal(handlers[0], authenticate);
  }
});

test('current diary excludes finalized sessions but keeps review-pending sessions eligible', async () => {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('clinical_bladder_diary_sessions')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };
  const { routes } = registerRoutes({ connect: async () => client });

  const res = await invoke(routes, 'GET /api/patient/m2/sessions/current', createRequest());

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, 'SESSION_NOT_FOUND');
  assert.match(
    queries[0].sql,
    /state IN \('draft', 'active', 'in_progress', 'submitted', 'under_review'\)/
  );
});

test('current diary excludes voided events and formats capture metadata', async () => {
  const now = new Date();
  const session = {
    id: 'session-id',
    state: 'active',
    starts_at: new Date(now.getTime() - 60_000),
    ends_at: new Date(now.getTime() + 60_000),
  };
  const event = {
    id: 'event-id',
    diary_session_id: session.id,
    event_type: 'fluid',
    occurred_at: now,
    captured_at: new Date(now.getTime() + 1_000),
    created_at: new Date(now.getTime() + 2_000),
    volume_ml: '250',
    fluid_type: 'water',
    is_measured: true,
  };
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes('clinical_bladder_diary_sessions')) return { rows: [session] };
      if (sql.includes('clinical_bladder_diary_events')) return { rows: [event] };
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };
  const { routes } = registerRoutes({ connect: async () => client });

  const res = await invoke(routes, 'GET /api/patient/m2/sessions/current', createRequest());

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.events[0].recordedAt, event.captured_at);
  assert.equal(res.body.events[0].fluidType, 'water');
  assert.match(queries[1], /voided_at IS NULL/);
});

test('session creation takes an enrollment-scoped transaction lock', async () => {
  const now = new Date();
  const session = {
    id: 'session-id',
    state: 'draft',
    starts_at: now,
    ends_at: new Date(now.getTime() + 72 * 60 * 60 * 1000),
  };
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}] };
      if (sql.includes('clinical_bladder_diary_sessions')) return { rows: [session] };
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };
  const { routes } = registerRoutes({ connect: async () => client });

  const res = await invoke(routes, 'POST /api/patient/m2/sessions/current', createRequest());

  assert.equal(res.statusCode, 200);
  const lock = queries.find((query) => query.sql.includes('pg_advisory_xact_lock'));
  assert.deepEqual(lock.params, ['enrollment-id']);
  assert.ok(queries.indexOf(lock) < queries.findIndex((query) => query.sql.includes('state IN')));
});

test('event creation rejects closed sessions', async () => {
  const now = new Date();
  const client = {
    async query(sql) {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('information_schema.columns')) {
        return { rows: [{ column_name: 'metadata' }] };
      }
      if (sql.includes(`metadata->>'idempotencyKey'`)) return { rows: [] };
      if (sql.includes('clinical_bladder_diary_sessions')) {
        return {
          rows: [{
            id: 'session-id',
            state: 'submitted',
            starts_at: new Date(now.getTime() - 60_000),
            ends_at: new Date(now.getTime() + 60_000),
          }],
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };
  const { routes } = registerRoutes({ connect: async () => client });
  const req = createRequest(
    { sessionId: 'session-id', eventType: 'void', amountMl: 100, occurredAt: now },
    {},
    { 'idempotency-key': 'event-key' }
  );

  const res = await invoke(routes, 'POST /api/patient/m2/events', req);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'SESSION_CLOSED');
});

test('event creation applies type-aware clinical validation', async () => {
  const now = new Date();
  const session = {
    id: 'session-id',
    state: 'active',
    starts_at: new Date(now.getTime() - 60_000),
    ends_at: new Date(now.getTime() + 60 * 60_000),
  };
  const makeClient = () => ({
    async query(sql) {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('information_schema.columns')) {
        return { rows: [{ column_name: 'metadata' }] };
      }
      if (sql.includes(`metadata->>'idempotencyKey'`)) return { rows: [] };
      if (sql.includes('clinical_bladder_diary_sessions')) return { rows: [session] };
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  });
  const cases = [
    { body: { eventType: 'void', occurredAt: now }, status: 400, message: /positive amountMl/ },
    { body: { eventType: 'leakage', occurredAt: now }, status: 400, message: /leakageAmount/ },
    { body: { eventType: 'sleep_start', occurredAt: now, urgency: 2 }, status: 400, message: /Sleep events/ },
    { body: { eventType: 'fluid', occurredAt: now, amountMl: 100, urgency: 1.5 }, status: 400, message: /integer/ },
    {
      body: { eventType: 'fluid', occurredAt: new Date(now.getTime() + 10 * 60_000), amountMl: 100 },
      status: 422,
      message: /future-dated/,
    },
  ];

  for (const [index, item] of cases.entries()) {
    const { routes } = registerRoutes({ connect: async () => makeClient() });
    const req = createRequest(
      { sessionId: session.id, ...item.body },
      {},
      { 'idempotency-key': `event-key-${index}` }
    );
    const res = await invoke(routes, 'POST /api/patient/m2/events', req);
    assert.equal(res.statusCode, item.status);
    assert.match(res.body.error, item.message);
  }
});

test('event validation normalizes unmeasured volume and fluid metadata', () => {
  const now = new Date();
  const session = {
    starts_at: new Date(now.getTime() - 60_000),
    ends_at: new Date(now.getTime() + 60_000),
  };

  const unmeasured = _test.validateDiaryEventPayload({
    eventType: 'void',
    occurredAt: now,
    measured: false,
    amountMl: 300,
  }, session);
  assert.equal(unmeasured.error, undefined);
  assert.equal(unmeasured.amountMl, null);

  const fluid = _test.validateDiaryEventPayload({
    eventType: 'fluid',
    occurredAt: now,
    measured: true,
    amountMl: 250,
    fluidType: 'water',
    urgency: 3,
  }, session);
  assert.equal(fluid.fluidType, 'water');
  assert.equal(fluid.amountMl, 250);
  assert.equal(fluid.urgencyScore, null);
});

test('event patch rejects updates when the owning session is closed', async () => {
  const now = new Date();
  const client = {
    async query(sql) {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FROM clinical_bladder_diary_events e')) {
        return {
          rows: [{
            id: 'event-id',
            event_type: 'void',
            session_state: 'reviewed',
            session_starts_at: new Date(now.getTime() - 60_000),
            session_ends_at: new Date(now.getTime() + 60_000),
          }],
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };
  const { routes } = registerRoutes({ connect: async () => client });

  const res = await invoke(
    routes,
    'PATCH /api/patient/m2/events/:id',
    createRequest({ operation: 'update', amountMl: 200 }, { id: 'event-id' })
  );

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'SESSION_CLOSED');
});

test('submit rejects an active 72-hour window before counting events', async () => {
  const now = new Date();
  let counted = false;
  const client = {
    async query(sql) {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('clinical_bladder_diary_sessions')) {
        return {
          rows: [{
            id: 'session-id',
            state: 'active',
            starts_at: new Date(now.getTime() - 60_000),
            ends_at: new Date(now.getTime() + 60_000),
          }],
        };
      }
      if (sql.includes('COUNT(*)')) {
        counted = true;
        return { rows: [{ count: 1 }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };
  const { routes } = registerRoutes({ connect: async () => client });

  const res = await invoke(
    routes,
    'POST /api/patient/m2/submit',
    createRequest({ sessionId: 'session-id', testBypass: true })
  );

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'DIARY_WINDOW_ACTIVE');
  assert.equal(counted, false);
});

test('submit bypasses only the timer when enrollment test mode is enabled', async () => {
  const now = new Date();
  let counted = false;
  const client = {
    async query(sql) {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('clinical_bladder_diary_sessions')) {
        return {
          rows: [{
            id: 'session-id',
            state: 'active',
            starts_at: new Date(now.getTime() - 60_000),
            ends_at: new Date(now.getTime() + 60_000),
          }],
        };
      }
      if (sql.includes('COUNT(*)')) {
        counted = true;
        return { rows: [{ count: 0 }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };
  const getEnrollment = async () => ({
    id: 'enrollment-id',
    app_id: 'app-id',
    metadata: { clinical_test_mode: true },
  });
  const { routes } = registerRoutes({ connect: async () => client }, getEnrollment);

  const res = await invoke(
    routes,
    'POST /api/patient/m2/submit',
    createRequest({ sessionId: 'session-id', testBypass: true })
  );

  assert.equal(res.statusCode, 422);
  assert.equal(res.body.code, 'EMPTY_DIARY');
  assert.equal(counted, true);
});

test('submit remains idempotent for an already submitted session', async () => {
  let counted = false;
  const session = {
    id: 'session-id',
    state: 'submitted',
    starts_at: new Date(Date.now() - 73 * 60 * 60 * 1000),
    ends_at: new Date(Date.now() - 60 * 60 * 1000),
    submitted_at: new Date(),
  };
  const client = {
    async query(sql) {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
      if (sql.includes('clinical_bladder_diary_sessions')) return { rows: [session] };
      if (sql.includes('COUNT(*)')) counted = true;
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };
  const { routes } = registerRoutes({ connect: async () => client });

  const res = await invoke(
    routes,
    'POST /api/patient/m2/submit',
    createRequest({ sessionId: 'session-id' })
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'submitted');
  assert.equal(counted, false);
});

test('submit counts only non-voided events from the requested session', async () => {
  const now = new Date();
  let countQuery;
  const client = {
    async query(sql, params) {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('clinical_bladder_diary_sessions')) {
        return {
          rows: [{
            id: 'session-id',
            state: 'active',
            starts_at: new Date(now.getTime() - 73 * 60 * 60 * 1000),
            ends_at: new Date(now.getTime() - 60 * 60 * 1000),
          }],
        };
      }
      if (sql.includes('COUNT(*)')) {
        countQuery = { sql, params };
        return { rows: [{ count: 0 }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };
  const { routes } = registerRoutes({ connect: async () => client });

  const res = await invoke(
    routes,
    'POST /api/patient/m2/submit',
    createRequest({ sessionId: 'session-id' })
  );

  assert.equal(res.statusCode, 422);
  assert.equal(res.body.code, 'EMPTY_DIARY');
  assert.match(countQuery.sql, /diary_session_id = \$1 AND voided_at IS NULL/);
  assert.deepEqual(countQuery.params, ['session-id']);
});

test('derives stable UUIDs from idempotency keys', () => {
  const first = _test.idForKey('offline-event-123');
  const second = _test.idForKey('offline-event-123');
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first, _test.idForKey('offline-event-124'));
});

test('recognizes absent migration tables and columns', () => {
  assert.equal(_test.isMissingSchemaError({ code: '42P01' }), true);
  assert.equal(_test.isMissingSchemaError({ code: '42703' }), true);
  assert.equal(_test.isMissingSchemaError({ code: '23505' }), false);
});

test('loads published plan versions with explicit UUID parameter casts', async () => {
  const plan = {
    id: '8f69144b-d3ac-449e-b600-b5b5461b9b6c',
    status: 'published',
    published_version_id: '4d5e0ace-5165-4a1a-b925-d1364abdf03e',
    approved_version_id: null,
    current_version_id: '4d5e0ace-5165-4a1a-b925-d1364abdf03e',
  };
  const version = {
    id: plan.published_version_id,
    plan_id: plan.id,
    version_number: 1,
    content: { patientGoal: 'Test hedefi' },
  };
  const client = {
    async query(sql) {
      if (sql.includes('FROM clinical_plans')) return { rows: [plan] };
      if (sql.includes('FROM clinical_plan_versions')) {
        assert.match(sql, /\$2::uuid/);
        assert.match(sql, /\$3::uuid/);
        assert.match(sql, /\$4::uuid/);
        return { rows: [version] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const result = await _test.loadActivePlan(client, 'enrollment-id');

  assert.equal(result.currentVersion.id, version.id);
});

test('maps clinician plan fields to patient-facing lists', () => {
  assert.deepEqual(
    _test.planContentList(undefined, 'Tuvalet aralığını kontrollü uzatın.'),
    ['Tuvalet aralığını kontrollü uzatın.']
  );
  assert.deepEqual(
    _test.planContentList(['Birinci adım', 'İkinci adım'], 'Yedek metin'),
    ['Birinci adım', 'İkinci adım']
  );
});

test('returns a legacy-safe state before the migration exists', async () => {
  const client = {
    async query() {
      return { rows: [{ count: 0 }] };
    },
  };
  const result = await getClinicalBundle(client, { id: 'enrollment-id' }, 'patient-id');
  assert.deepEqual(result, {
    clinicalState: {
      enabled: false,
      mode: 'legacy',
      currentModule: null,
      state: 'legacy',
      testModeEnabled: false,
    },
    gates: [],
    activePlanSummary: null,
  });
});
