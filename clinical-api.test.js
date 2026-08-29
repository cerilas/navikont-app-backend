const test = require('node:test');
const assert = require('node:assert/strict');
const { getClinicalBundle, registerClinicalApi, _test } = require('./clinical-api');

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

test('returns a legacy-safe state before the migration exists', async () => {
  const client = {
    async query() {
      return { rows: [{ count: 0 }] };
    },
  };
  const result = await getClinicalBundle(client, { id: 'enrollment-id' }, 'patient-id');
  assert.deepEqual(result, {
    clinicalState: { enabled: false, mode: 'legacy', currentModule: null, state: 'legacy' },
    gates: [],
    activePlanSummary: null,
  });
});
