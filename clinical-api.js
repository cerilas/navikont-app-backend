const crypto = require('crypto');

const CLINICAL_TABLES = [
  'therapeutic_module_registry',
  'therapeutic_module_sessions',
  'clinical_asset_completions',
  'clinical_bladder_diary_sessions',
  'clinical_bladder_diary_events',
  'clinical_bladder_diary_event_revisions',
  'clinical_plans',
  'clinical_plan_versions',
  'clinical_teachback_episodes',
  'clinical_teachback_responses',
  'clinical_m5_records',
  'clinical_review_snapshots',
  'clinical_review_episodes',
  'clinical_decisions',
  'clinical_activation_orders',
  'clinical_audit_events',
];

const columnCache = new Map();
const EDITABLE_DIARY_STATES = ['draft', 'active', 'in_progress'];
const DIARY_EVENT_TYPES = ['void', 'fluid', 'leakage', 'sleep_start', 'sleep_end'];
const MATERIAL_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

function isMissingSchemaError(error) {
  return ['42P01', '42703'].includes(error?.code);
}

async function tableColumns(client, table) {
  if (columnCache.has(table)) return columnCache.get(table);
  const result = await client.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1`,
    [table]
  );
  const columns = new Set(result.rows.map((row) => row.column_name));
  if (columns.size > 0) columnCache.set(table, columns);
  return columns;
}

async function clinicalSchemaAvailable(client) {
  const result = await client.query(
    `SELECT COUNT(*)::int AS count
       FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name = ANY($1::text[])`,
    [CLINICAL_TABLES]
  );
  return result.rows[0].count === CLINICAL_TABLES.length;
}

async function safeRows(client, query, values = []) {
  try {
    return (await client.query(query, values)).rows;
  } catch (error) {
    if (isMissingSchemaError(error)) return [];
    throw error;
  }
}

async function insertCompatible(client, table, values) {
  const columns = await tableColumns(client, table);
  if (columns.size === 0) {
    const error = new Error(`Clinical table ${table} is unavailable`);
    error.code = 'CLINICAL_SCHEMA_MISSING';
    throw error;
  }
  const entries = Object.entries(values).filter(([key, value]) => columns.has(key) && value !== undefined);
  if (entries.length === 0) throw new Error(`No compatible columns for ${table}`);
  const names = entries.map(([key]) => `"${key}"`);
  const placeholders = entries.map((_, index) => `$${index + 1}`);
  const params = entries.map(([, value]) => value);
  const result = await client.query(
    `INSERT INTO "${table}" (${names.join(', ')})
     VALUES (${placeholders.join(', ')})
     RETURNING *`,
    params
  );
  return result.rows[0];
}

async function updateCompatible(client, table, id, values, extraWhere = '', extraParams = []) {
  const columns = await tableColumns(client, table);
  const entries = Object.entries(values).filter(([key, value]) => columns.has(key) && value !== undefined);
  if (entries.length === 0) return null;
  const assignments = entries.map(([key], index) => `"${key}" = $${index + 1}`);
  const params = entries.map(([, value]) => value);
  params.push(id, ...extraParams);
  const result = await client.query(
    `UPDATE "${table}"
        SET ${assignments.join(', ')}
      WHERE id = $${entries.length + 1} ${extraWhere}
      RETURNING *`,
    params
  );
  return result.rows[0] || null;
}

async function findIdempotent(client, table, enrollmentId, key) {
  if (!key) return null;
  const columns = await tableColumns(client, table);
  const keyColumn = ['idempotency_key', 'client_event_id', 'client_record_id']
    .find((column) => columns.has(column));
  if (!keyColumn && columns.has('metadata')) {
    const ownerColumn = columns.has('enrollment_id') ? 'enrollment_id' : null;
    const result = await client.query(
      `SELECT * FROM "${table}"
        WHERE metadata->>'idempotencyKey' = $1
          ${ownerColumn ? `AND "${ownerColumn}" = $2` : ''}
        LIMIT 1`,
      ownerColumn ? [key, enrollmentId] : [key]
    );
    return result.rows[0] || null;
  }
  if (!keyColumn) return null;
  const ownerColumn = columns.has('enrollment_id') ? 'enrollment_id' : null;
  const result = await client.query(
    `SELECT * FROM "${table}"
      WHERE "${keyColumn}" = $1
        ${ownerColumn ? `AND "${ownerColumn}" = $2` : ''}
      LIMIT 1`,
    ownerColumn ? [key, enrollmentId] : [key]
  );
  return result.rows[0] || null;
}

function idempotencyKey(req, body = req.body || {}) {
  return req.get('Idempotency-Key') || body.idempotencyKey || body.clientEventId || body.clientRecordId || null;
}

function idForKey(key) {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(key))) {
    return String(key);
  }
  const hex = crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

function moduleCode(row) {
  return String(row.module_code || row.module_key || row.module || '').toUpperCase();
}

function activeRow(row) {
  return !['voided', 'cancelled', 'superseded', 'revoked', 'suspended'].includes(String(row.state || row.status || '').toLowerCase());
}

function latestByDate(rows) {
  return rows[0] || null;
}

function editableDiarySession(row) {
  return EDITABLE_DIARY_STATES.includes(String(row?.state || row?.status || '').toLowerCase());
}

function normalizeDiaryEventType(value) {
  const eventType = String(value || '').toLowerCase();
  return eventType === 'urination' ? 'void' : eventType;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function validationFailure(error, code = 'VALIDATION_ERROR', status = 400) {
  return { error, code, status };
}

function validateDiaryEventPayload(payload, session, currentEvent = null) {
  const eventType = normalizeDiaryEventType(
    payload.eventType ?? payload.type ?? currentEvent?.event_type
  );
  if (!DIARY_EVENT_TYPES.includes(eventType)) {
    return validationFailure('Invalid event type');
  }

  const occurredAtValue = hasOwn(payload, 'occurredAt') ? payload.occurredAt : currentEvent?.occurred_at;
  const occurredAt = occurredAtValue ? new Date(occurredAtValue) : new Date();
  if (Number.isNaN(occurredAt.getTime())) {
    return validationFailure('Invalid occurredAt');
  }
  if (occurredAt < new Date(session.starts_at) || occurredAt > new Date(session.ends_at)) {
    return validationFailure('Event is outside the diary window', 'EVENT_OUTSIDE_WINDOW', 422);
  }
  if (occurredAt.getTime() > Date.now() + MATERIAL_FUTURE_TOLERANCE_MS) {
    return validationFailure('Event cannot be future-dated', 'EVENT_FUTURE_DATED', 422);
  }

  const sameType = currentEvent && normalizeDiaryEventType(currentEvent.event_type) === eventType;
  const urgencyValue = hasOwn(payload, 'urgencyLevel')
    ? payload.urgencyLevel
    : hasOwn(payload, 'urgency')
      ? payload.urgency
      : sameType ? currentEvent.urgency_score : null;
  if (urgencyValue != null &&
      (!Number.isInteger(Number(urgencyValue)) || Number(urgencyValue) < 0 || Number(urgencyValue) > 4)) {
    return validationFailure('Urgency must be an integer between 0 and 4');
  }

  const measured = hasOwn(payload, 'measured')
    ? Boolean(payload.measured)
    : hasOwn(payload, 'unableToMeasure')
      ? !Boolean(payload.unableToMeasure)
      : sameType ? currentEvent.is_measured : true;
  const amountValue = hasOwn(payload, 'amountMl')
    ? payload.amountMl
    : sameType ? currentEvent.volume_ml : null;
  const leakageAmount = hasOwn(payload, 'leakageAmount')
    ? payload.leakageAmount
    : sameType ? currentEvent.leakage_amount : null;
  const fluidType = hasOwn(payload, 'fluidType')
    ? payload.fluidType
    : sameType ? currentEvent.fluid_type : null;

  if (['void', 'fluid'].includes(eventType) && measured) {
    const amount = Number(amountValue);
    if (!Number.isFinite(amount) || amount <= 0) {
      return validationFailure('Measured void and fluid events require a positive amountMl');
    }
  }
  if (eventType === 'leakage' &&
      (leakageAmount == null || String(leakageAmount).trim() === '')) {
    return validationFailure('Leakage events require leakageAmount');
  }
  if (eventType.startsWith('sleep_')) {
    const sleepFields = [
      hasOwn(payload, 'amountMl') ? payload.amountMl : null,
      hasOwn(payload, 'urgencyLevel') ? payload.urgencyLevel : null,
      hasOwn(payload, 'urgency') ? payload.urgency : null,
      hasOwn(payload, 'leakageAmount') ? payload.leakageAmount : null,
    ];
    if (sleepFields.some((value) => value != null)) {
      return validationFailure('Sleep events must not include volume, urgency, or leakage');
    }
  }

  return {
    eventType,
    occurredAt,
    urgencyScore: ['void', 'leakage'].includes(eventType) && urgencyValue != null
      ? Number(urgencyValue)
      : null,
    measured: ['void', 'fluid'].includes(eventType) ? measured : false,
    amountMl: ['void', 'fluid'].includes(eventType) && measured ? Number(amountValue) : null,
    leakageAmount: eventType === 'leakage' ? leakageAmount : null,
    fluidType: eventType === 'fluid' ? (fluidType ?? null) : null,
  };
}

function formatDiaryEvent(row) {
  const metadata = row.metadata || {};
  return {
    id: row.id,
    sessionId: row.diary_session_id,
    type: row.event_type,
    occurredAt: row.occurred_at,
    recordedAt: row.captured_at || row.created_at,
    amountMl: row.volume_ml == null ? null : Number(row.volume_ml),
    urgency: row.urgency_score,
    leakageAmount: row.leakage_amount,
    fluidType: row.fluid_type ?? null,
    measured: row.is_measured ?? metadata.unableToMeasure !== true,
    retrospective: row.time_entry_mode === 'retrospective' || metadata.isRetrospective === true,
    note: row.notes,
    storageState: 'SERVER_STORED',
  };
}

function formatDiarySession(row, events = null) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.state,
    startedAt: row.starts_at,
    endsAt: row.ends_at,
    submittedAt: row.submitted_at,
    ...(events ? { events: events.map(formatDiaryEvent) } : {}),
  };
}

function formatM5Record(row) {
  const values = row.values || {};
  return {
    id: row.id,
    recordType: row.record_type,
    occurredAt: row.recorded_at,
    urgency: values.urgency ?? null,
    outcome: values.outcome ?? null,
    notes: values.notes ?? null,
    storageState: 'SERVER_STORED',
  };
}

async function audit(client, enrollment, userId, action, entityType, entityId, oldData, newData, metadata = {}) {
  try {
    return await insertCompatible(client, 'clinical_audit_events', {
      id: crypto.randomUUID(),
      app_id: enrollment.app_id,
      enrollment_id: enrollment.id,
      patient_user_id: userId,
      actor_user_id: userId,
      actor_type: 'patient',
      action,
      event_type: action,
      entity_type: entityType,
      entity_id: entityId,
      old_data: oldData || null,
      new_data: newData || null,
      metadata,
      occurred_at: new Date(),
    });
  } catch (error) {
    if (!['CLINICAL_SCHEMA_MISSING', '23505'].includes(error.code)) throw error;
    return null;
  }
}

async function loadActivePlan(client, enrollmentId) {
  const plans = await safeRows(
    client,
    `SELECT * FROM clinical_plans
      WHERE enrollment_id = $1
        AND status = 'published'
        AND published_version_id IS NOT NULL
      ORDER BY created_at DESC`,
    [enrollmentId]
  );
  const plan = plans[0] || null;
  if (!plan) return null;
  const versions = await safeRows(
    client,
    `SELECT * FROM clinical_plan_versions
      WHERE id = COALESCE($2::uuid, $3::uuid, $4::uuid)
         OR (plan_id = $1 AND COALESCE($2::uuid, $3::uuid, $4::uuid) IS NULL)
      ORDER BY version_number DESC, created_at DESC
      LIMIT 1`,
    [plan.id, plan.published_version_id, plan.approved_version_id, plan.current_version_id]
  );
  const version = versions[0] || null;
  if (!version) return null;
  return { ...plan, currentVersion: version };
}

function planSummary(plan) {
  if (!plan) return null;
  const version = plan.currentVersion;
  return {
    planId: plan.id,
    status: plan.status,
    versionId: version.id,
    versionNumber: version.version_number,
    title: version.title || plan.title || null,
    summary: version.summary || version.patient_summary || null,
    publishedAt: version.published_at || null,
    parameters: version.parameters || version.plan_data || version.content || {},
  };
}

async function getClinicalBundle(client, enrollment, userId) {
  const ntmsEnabled = enrollment?.metadata?.ntms_enabled === true && enrollment?.metadata?.legacy_mode !== true;
  if (!enrollment || !ntmsEnabled || !(await clinicalSchemaAvailable(client))) {
    return {
      clinicalState: {
        enabled: false,
        mode: 'legacy',
        currentModule: null,
        state: 'legacy',
        testModeEnabled: false,
      },
      gates: [],
      activePlanSummary: null,
    };
  }

  try {
    const [
      moduleSessions,
      diarySessions,
      reviewEpisodes,
      decisions,
      activationOrders,
      teachbacks,
      assetCompletions,
      m5Records,
      plan,
    ] = await Promise.all([
      safeRows(client, `SELECT cms.*, ctm.module_key FROM therapeutic_module_sessions cms JOIN therapeutic_module_registry ctm ON ctm.id = cms.therapeutic_module_id WHERE cms.enrollment_id = $1 ORDER BY cms.created_at DESC`, [enrollment.id]),
      safeRows(client, `SELECT * FROM clinical_bladder_diary_sessions WHERE enrollment_id = $1 ORDER BY created_at DESC`, [enrollment.id]),
      safeRows(client, `SELECT * FROM clinical_review_episodes WHERE enrollment_id = $1 ORDER BY created_at DESC`, [enrollment.id]),
      safeRows(client, `SELECT * FROM clinical_decisions WHERE enrollment_id = $1 ORDER BY created_at DESC`, [enrollment.id]),
      safeRows(client, `SELECT * FROM clinical_activation_orders WHERE enrollment_id = $1 ORDER BY created_at DESC`, [enrollment.id]),
      safeRows(client, `SELECT * FROM clinical_teachback_episodes WHERE enrollment_id = $1 ORDER BY created_at DESC`, [enrollment.id]),
      safeRows(client, `SELECT * FROM clinical_asset_completions WHERE enrollment_id = $1 AND completion_state = 'completed'`, [enrollment.id]),
      safeRows(client, `SELECT * FROM clinical_m5_records WHERE enrollment_id = $1 AND status = 'active' ORDER BY recorded_at DESC`, [enrollment.id]),
      loadActivePlan(client, enrollment.id),
    ]);

    const sessionsByModule = {};
    for (const session of moduleSessions) {
      const code = moduleCode(session);
      if (code && !sessionsByModule[code]) sessionsByModule[code] = session;
    }
    const sessionCompleted = (code) => ['completed', 'approved', 'passed'].includes(
      String(sessionsByModule[code]?.state || sessionsByModule[code]?.status || '').toLowerCase()
    );
    const submittedDiary = diarySessions.some((row) =>
      ['submitted', 'under_review', 'reviewed', 'approved'].includes(String(row.state || row.status || '').toLowerCase())
    );
    const diaryReviewed = diarySessions.some((row) =>
      ['reviewed', 'approved'].includes(String(row.state || row.status || '').toLowerCase())
    ) || reviewEpisodes.some((row) =>
      ['completed', 'approved', 'closed'].includes(String(row.state || row.status || '').toLowerCase())
    );
    const publishedPlan = Boolean(plan);
    const teachbackPassed = teachbacks.some((row) =>
      ['passed', 'completed', 'accepted'].includes(String(row.state || row.status || '').toLowerCase())
    );
    const latestDecision = decisions.find(activeRow) || null;
    const m7Orders = activationOrders.filter((row) =>
      ['active', 'activated', 'published', 'approved'].includes(String(row.state || row.status || '').toLowerCase())
    );
    const m8Directed = decisions.some((row) =>
      String(row.module_key || '').toUpperCase() === 'M8' ||
      String(row.decision || '').toUpperCase() === 'ROUTE_TO_M8_FINAL_REVIEW' ||
      String(row.payload?.primaryRoute || '').toUpperCase() === 'ROUTE_TO_M8_FINAL_REVIEW' ||
      ['m8', 'close', 'closure', 'terminate', 'completed'].includes(
        String(row.decision_type || row.action || row.outcome || '').toLowerCase()
      )
    );
    const completedAssetIds = new Set(assetCompletions.map((row) => row.asset_id));
    const hasM5Summary = m5Records.some((row) => row.record_type === 'APPLICATION_SUMMARY');
    const hasM6Decision = decisions.some((row) => String(row.module_key).toUpperCase() === 'M6');
    const hasM8Closure = decisions.some((row) =>
      String(row.module_key).toUpperCase() === 'M8' &&
      String(row.decision_type).toLowerCase() === 'closure'
    );
    const completed = (code) => sessionCompleted(code) || ({
      M1: completedAssetIds.has('M1-INTRO'),
      M2: diaryReviewed,
      M3: publishedPlan && teachbackPassed,
      M4: completedAssetIds.has('M4-SIMULATION'),
      M5: hasM5Summary,
      M6: hasM6Decision,
      M7: m7Orders.length > 0,
      M8: hasM8Closure,
    }[code] === true);

    const gates = {
      M1: { unlocked: true, reason: null },
      M2: { unlocked: completed('M1') || Boolean(sessionsByModule.M2), reason: completed('M1') ? null : 'M1_REQUIRED' },
      M3: { unlocked: submittedDiary && diaryReviewed, reason: submittedDiary ? 'CLINICIAN_REVIEW_REQUIRED' : 'M2_SUBMISSION_REQUIRED' },
      M4: { unlocked: publishedPlan && teachbackPassed, reason: publishedPlan ? 'TEACHBACK_REQUIRED' : 'PUBLISHED_PLAN_REQUIRED' },
      M5: { unlocked: completed('M4'), reason: 'M4_SIMULATION_REQUIRED' },
      M6: { unlocked: completed('M5') || Boolean(sessionsByModule.M6), reason: 'M5_REQUIRED' },
      M7: { unlocked: m7Orders.length > 0, reason: 'ACTIVATION_ORDER_REQUIRED', packages: m7Orders },
      M8: { unlocked: m8Directed, reason: 'CLINICIAN_HANDOFF_REQUIRED' },
    };
    for (const gate of Object.values(gates)) {
      if (gate.unlocked) gate.reason = null;
    }

    const currentModule = ['M8', 'M7', 'M6', 'M5', 'M4', 'M3', 'M2', 'M1']
      .find((code) => gates[code].unlocked && !completed(code)) || 'M8';
    const gateList = Object.entries(gates).map(([code, gate]) => ({
      id: code,
      module: code,
      state: gate.unlocked ? 'open' : (gate.reason?.includes('REVIEW') ? 'pending' : 'locked'),
      reasonCode: gate.reason,
      message: null,
      isVisible: gate.unlocked || code === currentModule,
    }));
    const syntheticScreens = {
      M1: [{ contentId: 'M1-INTRO', kind: 'article', title: 'Programı tanıyın', body: 'Eğitim adımlarını tamamladıktan sonra 72 saatlik mesane günlüğüne geçebilirsiniz.' }],
      M2: [{ contentId: 'M2-DIARY', kind: 'bladder_diary', title: '72 saatlik mesane günlüğü' }],
      M3: [
        { contentId: 'M3-PLAN', kind: 'plan', title: 'Tedavi planım' },
        ...(teachbacks[0] ? [{
          contentId: 'M3-TEACHBACK',
          kind: 'teach_back',
          title: teachbacks[0].metadata?.title || 'Planımı anladım',
          teachBack: {
            id: teachbacks[0].id,
            planVersionId: teachbacks[0].metadata?.planVersionId || null,
            title: teachbacks[0].metadata?.title || null,
            prompts: teachbacks[0].metadata?.prompts || [],
            completedAt: teachbacks[0].completed_at || null,
          },
        }] : []),
      ],
      M4: [{ contentId: 'M4-SIMULATION', kind: 'urgency_simulation', title: 'Güvenli uygulama simülasyonu' }],
      M5: [{ contentId: 'M5-APPLICATION', kind: 'm5_hub', title: 'Gerçek yaşam uygulamaları' }],
      M6: [{ contentId: 'M6-REVIEW', kind: 'm6_review', title: 'Klinik değerlendirme' }],
      M7: [{ contentId: 'M7-ACTIVATION', kind: 'm7_activation', title: 'Etkinleştirilen destekler' }],
      M8: [{ contentId: 'M8-CLOSURE', kind: 'm8_closure', title: 'Program kapanışı' }],
    };
    const screens = (syntheticScreens[currentModule] || []).map((screen, index) => ({
      id: idForKey(`${enrollment.id}:${screen.contentId}`),
      contentVersion: 'v1.0',
      module: currentModule,
      subtitle: null,
      body: null,
      mediaUrl: null,
      transcript: null,
      isRequired: true,
      isCompleted: completedAssetIds.has(screen.contentId) ||
        (screen.contentId === 'M3-TEACHBACK' && teachbackPassed),
      metadata: { order: index },
      ...screen,
    }));
    return {
      clinicalState: {
        enabled: true,
        mode: enrollment.metadata?.legacy_mode ? 'legacy' : 'clinical',
        currentModule,
        state: sessionsByModule[currentModule]?.state || sessionsByModule[currentModule]?.status || 'available',
        enrollmentId: enrollment.id,
        moduleSessions: sessionsByModule,
        latestDecision,
        awaitingClinician: submittedDiary && !diaryReviewed,
        testModeEnabled: enrollment.metadata?.clinical_test_mode === true,
      },
      gates: gateList,
      activePlanSummary: planSummary(plan),
      screens,
    };
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return {
        clinicalState: {
          enabled: false,
          mode: 'legacy',
          currentModule: null,
          state: 'legacy',
          testModeEnabled: false,
        },
        gates: [],
        activePlanSummary: null,
      };
    }
    throw error;
  }
}

function requireClinicalSchema(error, res, label) {
  if (error.code === 'CLINICAL_SCHEMA_MISSING' || isMissingSchemaError(error)) {
    return res.status(503).json({
      error: 'Clinical features are not available yet',
      code: 'CLINICAL_SCHEMA_UNAVAILABLE',
    });
  }
  console.error(`${label} error:`, error);
  return res.status(500).json({ error: 'Internal server error' });
}

function noEnrollment(res) {
  return res.status(404).json({ error: 'No active enrollment found', code: 'ENROLLMENT_NOT_FOUND' });
}

function registerClinicalApi({ app, pool, authenticate, getEnrollment }) {
  app.get('/api/patient/clinical-state', authenticate, async (req, res) => {
    const client = await pool.connect();
    try {
      const enrollment = await getEnrollment(client, req.user.userId);
      if (!enrollment) return noEnrollment(res);
      res.json(await getClinicalBundle(client, enrollment, req.user.userId));
    } catch (error) {
      requireClinicalSchema(error, res, 'Clinical state');
    } finally {
      client.release();
    }
  });

  app.post('/api/patient/clinical/assets/:contentId/complete', authenticate, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const enrollment = await getEnrollment(client, req.user.userId);
      if (!enrollment) {
        await client.query('ROLLBACK');
        return noEnrollment(res);
      }
      const key = idempotencyKey(req) || `${enrollment.id}:${req.params.contentId}`;
      const content = await client.query(
        `SELECT id FROM content_journey_steps
          WHERE journey_id = $1 AND content_id = $2
          LIMIT 1`,
        [enrollment.journey_id, req.params.contentId]
      );
      if (!content.rows[0]) {
        const syntheticMatch = req.params.contentId.match(/^(M[1-8])(?:-[A-Z0-9_-]+)?$/);
        const syntheticModule = syntheticMatch?.[1] || null;
        const clinical = await getClinicalBundle(client, enrollment, req.user.userId);
        if (!syntheticModule || !clinical.clinicalState.enabled ||
            clinical.clinicalState.currentModule !== syntheticModule) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Clinical asset not found', code: 'ASSET_NOT_FOUND' });
        }
      }
      const contentVersion = req.body.contentVersion || 'v1.0';
      if (req.body.sessionId) {
        const ownedSession = await client.query(
          `SELECT id FROM therapeutic_module_sessions WHERE id = $1 AND enrollment_id = $2`,
          [req.body.sessionId, enrollment.id]
        );
        if (!ownedSession.rows[0]) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Module session not found', code: 'SESSION_NOT_FOUND' });
        }
      }
      const existing = await client.query(
        `SELECT * FROM clinical_asset_completions
          WHERE enrollment_id = $1 AND asset_id = $2
            AND asset_version IS NOT DISTINCT FROM $3
          LIMIT 1`,
        [enrollment.id, req.params.contentId, contentVersion]
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return res.json({ success: true, completion: existing.rows[0], idempotent: true });
      }
      const completion = await insertCompatible(client, 'clinical_asset_completions', {
        id: crypto.randomUUID(),
        app_id: enrollment.app_id,
        enrollment_id: enrollment.id,
        patient_user_id: req.user.userId,
        module_session_id: req.body.sessionId,
        asset_id: req.params.contentId,
        asset_version: contentVersion,
        completion_state: 'completed',
        evidence: req.body.completionData || req.body.resultData || {},
        idempotency_key: key,
        metadata: { idempotencyKey: key },
        completed_at: new Date(),
        created_at: new Date(),
        updated_at: new Date(),
      });
      await audit(client, enrollment, req.user.userId, 'asset.completed', 'patient_asset_completion', completion.id, null, completion);
      await client.query('COMMIT');
      res.status(201).json({ success: true, completion });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      requireClinicalSchema(error, res, 'Clinical asset completion');
    } finally {
      client.release();
    }
  });

  app.get('/api/patient/m2/sessions/current', authenticate, async (req, res) => {
    const client = await pool.connect();
    try {
      const enrollment = await getEnrollment(client, req.user.userId);
      if (!enrollment) return noEnrollment(res);
      const sessions = await safeRows(
        client,
        `SELECT * FROM clinical_bladder_diary_sessions
          WHERE enrollment_id = $1
            AND state IN ('draft', 'active', 'in_progress', 'submitted', 'under_review')
          ORDER BY created_at DESC LIMIT 1`,
        [enrollment.id]
      );
      const session = latestByDate(sessions);
      if (!session) return res.status(404).json({ error: 'Diary session not found', code: 'SESSION_NOT_FOUND' });
      const events = await safeRows(
        client,
        `SELECT * FROM clinical_bladder_diary_events
          WHERE diary_session_id = $1 AND voided_at IS NULL
          ORDER BY occurred_at ASC`,
        [session.id]
      );
      res.json(formatDiarySession(session, events));
    } catch (error) {
      requireClinicalSchema(error, res, 'M2 current session');
    } finally {
      client.release();
    }
  });

  app.post('/api/patient/m2/sessions/current', authenticate, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const enrollment = await getEnrollment(client, req.user.userId);
      if (!enrollment) {
        await client.query('ROLLBACK');
        return noEnrollment(res);
      }
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
        [enrollment.id]
      );
      const current = await safeRows(
        client,
        `SELECT * FROM clinical_bladder_diary_sessions
          WHERE enrollment_id = $1 AND state IN ('draft', 'active', 'in_progress')
          ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [enrollment.id]
      );
      if (current[0]) {
        await client.query('COMMIT');
        return res.json(formatDiarySession(current[0]));
      }
      const startedAt = req.body.startedAt ? new Date(req.body.startedAt) : new Date();
      if (Number.isNaN(startedAt.getTime())) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Invalid startedAt', code: 'VALIDATION_ERROR' });
      }
      const session = await insertCompatible(client, 'clinical_bladder_diary_sessions', {
        id: crypto.randomUUID(),
        app_id: enrollment.app_id,
        enrollment_id: enrollment.id,
        patient_user_id: req.user.userId,
        state: 'draft',
        starts_at: startedAt,
        ends_at: new Date(startedAt.getTime() + 72 * 60 * 60 * 1000),
        expected_end_at: new Date(startedAt.getTime() + 72 * 60 * 60 * 1000),
        timezone: req.body.timezone,
        metadata: req.body.metadata || {},
        created_at: new Date(),
        updated_at: new Date(),
      });
      await audit(client, enrollment, req.user.userId, 'm2.session.started', 'bladder_diary_session', session.id, null, session);
      await client.query('COMMIT');
      res.status(201).json(formatDiarySession(session));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      requireClinicalSchema(error, res, 'M2 start session');
    } finally {
      client.release();
    }
  });

  app.post('/api/patient/m2/events', authenticate, async (req, res) => {
    const eventType = normalizeDiaryEventType(req.body.eventType || req.body.type);
    if (!DIARY_EVENT_TYPES.includes(eventType)) {
      return res.status(400).json({ error: 'Invalid event type', code: 'VALIDATION_ERROR' });
    }
    const key = idempotencyKey(req);
    if (!key) return res.status(400).json({ error: 'Idempotency-Key is required', code: 'IDEMPOTENCY_KEY_REQUIRED' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const enrollment = await getEnrollment(client, req.user.userId);
      if (!enrollment) {
        await client.query('ROLLBACK');
        return noEnrollment(res);
      }
      const existing = await findIdempotent(client, 'clinical_bladder_diary_events', enrollment.id, key);
      if (existing) {
        await client.query('COMMIT');
        return res.json(formatDiaryEvent(existing));
      }
      const sessions = await client.query(
        `SELECT * FROM clinical_bladder_diary_sessions
          WHERE id = $1 AND enrollment_id = $2
          FOR UPDATE`,
        [req.body.sessionId, enrollment.id]
      );
      const session = sessions.rows[0];
      if (!session) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Diary session not found', code: 'SESSION_NOT_FOUND' });
      }
      if (!editableDiarySession(session)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Diary session is not editable', code: 'SESSION_CLOSED' });
      }
      const validated = validateDiaryEventPayload(req.body, session);
      if (validated.error) {
        await client.query('ROLLBACK');
        return res.status(validated.status).json({ error: validated.error, code: validated.code });
      }
      const isRetrospective = Boolean(req.body.isRetrospective ?? req.body.retrospective);
      const event = await insertCompatible(client, 'clinical_bladder_diary_events', {
        id: idForKey(key),
        app_id: enrollment.app_id,
        enrollment_id: enrollment.id,
        patient_user_id: req.user.userId,
        diary_session_id: session.id,
        event_type: validated.eventType,
        occurred_at: validated.occurredAt,
        captured_at: new Date(),
        time_entry_mode: isRetrospective ? 'retrospective' : 'real_time',
        is_measured: validated.measured,
        volume_ml: validated.amountMl,
        urgency_score: validated.urgencyScore,
        leakage_amount: validated.leakageAmount,
        fluid_type: validated.fluidType,
        metadata: {
          ...(req.body.payload || req.body.data || {}),
          idempotencyKey: key,
          isRetrospective,
          unableToMeasure: Boolean(req.body.unableToMeasure),
        },
        source: 'patient',
        notes: req.body.notes ?? req.body.note,
        idempotency_key: key,
        client_event_id: req.body.clientEventId || key,
        created_at: new Date(),
        updated_at: new Date(),
      });
      await audit(client, enrollment, req.user.userId, 'm2.event.created', 'bladder_diary_event', event.id, null, event);
      await client.query('COMMIT');
      res.status(201).json(formatDiaryEvent(event));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Duplicate event', code: 'DUPLICATE_EVENT' });
      }
      requireClinicalSchema(error, res, 'M2 create event');
    } finally {
      client.release();
    }
  });

  app.patch('/api/patient/m2/events/:id', authenticate, async (req, res) => {
    const operation = String(req.body.operation || req.body.action || 'update').toLowerCase();
    if (!['update', 'void', 'restore'].includes(operation)) {
      return res.status(400).json({ error: 'Invalid operation', code: 'VALIDATION_ERROR' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const enrollment = await getEnrollment(client, req.user.userId);
      if (!enrollment) {
        await client.query('ROLLBACK');
        return noEnrollment(res);
      }
      const result = await client.query(
        `SELECT e.*,
                s.state AS session_state,
                s.starts_at AS session_starts_at,
                s.ends_at AS session_ends_at
           FROM clinical_bladder_diary_events e
          JOIN clinical_bladder_diary_sessions s ON s.id = e.diary_session_id
         WHERE e.id = $1 AND s.enrollment_id = $2
         FOR UPDATE`,
        [req.params.id, enrollment.id]
      );
      const oldEvent = result.rows[0];
      if (!oldEvent) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Event not found', code: 'EVENT_NOT_FOUND' });
      }
      if (!EDITABLE_DIARY_STATES.includes(String(oldEvent.session_state || '').toLowerCase())) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Diary session is not editable', code: 'SESSION_CLOSED' });
      }
      const payload = req.body.event || req.body.changes || req.body;
      let validated = null;
      if (operation === 'update') {
        validated = validateDiaryEventPayload(payload, {
          starts_at: oldEvent.session_starts_at,
          ends_at: oldEvent.session_ends_at,
        }, oldEvent);
        if (validated.error) {
          await client.query('ROLLBACK');
          return res.status(validated.status).json({ error: validated.error, code: validated.code });
        }
      }
      const retrospectiveValue = hasOwn(payload, 'isRetrospective')
        ? payload.isRetrospective
        : hasOwn(payload, 'retrospective')
          ? payload.retrospective
          : undefined;
      const updated = await updateCompatible(client, 'clinical_bladder_diary_events', oldEvent.id, {
        event_type: operation === 'update' ? validated.eventType : undefined,
        occurred_at: operation === 'update' ? validated.occurredAt : undefined,
        volume_ml: operation === 'update' ? validated.amountMl : undefined,
        is_measured: operation === 'update' ? validated.measured : undefined,
        time_entry_mode: operation === 'update' && retrospectiveValue !== undefined
          ? (retrospectiveValue ? 'retrospective' : 'real_time')
          : undefined,
        urgency_score: operation === 'update' ? validated.urgencyScore : undefined,
        leakage_amount: operation === 'update' ? validated.leakageAmount : undefined,
        fluid_type: operation === 'update' ? validated.fluidType : undefined,
        metadata: operation === 'update' ? (payload.payload || payload.data) : undefined,
        notes: operation === 'update' ? (payload.notes ?? payload.note) : undefined,
        voided_at: operation === 'void' ? new Date() : operation === 'restore' ? null : undefined,
        void_reason: operation === 'void' ? req.body.reason : operation === 'restore' ? null : undefined,
        updated_at: new Date(),
      });
      const revisionCount = await client.query(
        `SELECT COALESCE(MAX(revision_number), 0) + 1 AS next_revision
           FROM clinical_bladder_diary_event_revisions WHERE event_id = $1`,
        [oldEvent.id]
      );
      const revision = await insertCompatible(client, 'clinical_bladder_diary_event_revisions', {
        id: crypto.randomUUID(),
        event_id: oldEvent.id,
        revision_number: Number(revisionCount.rows[0].next_revision),
        enrollment_id: enrollment.id,
        patient_user_id: req.user.userId,
        actor_user_id: req.user.userId,
        operation,
        revision_type: operation,
        reason: req.body.reason,
        snapshot: oldEvent,
        created_at: new Date(),
      });
      await audit(client, enrollment, req.user.userId, `m2.event.${operation}`, 'bladder_diary_event', oldEvent.id, oldEvent, updated);
      await client.query('COMMIT');
      res.json(formatDiaryEvent(updated));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      requireClinicalSchema(error, res, 'M2 revise event');
    } finally {
      client.release();
    }
  });

  app.post('/api/patient/m2/submit', authenticate, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const enrollment = await getEnrollment(client, req.user.userId);
      if (!enrollment) {
        await client.query('ROLLBACK');
        return noEnrollment(res);
      }
      const sessions = await client.query(
        `SELECT * FROM clinical_bladder_diary_sessions
          WHERE id = $1 AND enrollment_id = $2 FOR UPDATE`,
        [req.body.sessionId, enrollment.id]
      );
      const session = sessions.rows[0];
      if (!session) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Diary session not found', code: 'SESSION_NOT_FOUND' });
      }
      if (['submitted', 'under_review', 'reviewed', 'approved'].includes(String(session.state || session.status).toLowerCase())) {
        await client.query('COMMIT');
        return res.json(formatDiarySession(session));
      }
      const testBypass =
        req.body.testBypass === true &&
        enrollment.metadata?.clinical_test_mode === true;
      if (!testBypass && Date.now() < new Date(session.ends_at).getTime()) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'The 72-hour diary window is not complete', code: 'DIARY_WINDOW_ACTIVE' });
      }
      const count = await client.query(
        `SELECT COUNT(*)::int AS count FROM clinical_bladder_diary_events
          WHERE diary_session_id = $1 AND voided_at IS NULL`,
        [session.id]
      );
      if (count.rows[0].count === 0) {
        await client.query('ROLLBACK');
        return res.status(422).json({ error: 'At least one diary event is required', code: 'EMPTY_DIARY' });
      }
      const updated = await updateCompatible(client, 'clinical_bladder_diary_sessions', session.id, {
        state: 'submitted',
        submitted_at: new Date(),
        submission_metadata: {
          ...(req.body.metadata || {}),
          testBypass,
        },
        updated_at: new Date(),
      });
      await audit(
        client,
        enrollment,
        req.user.userId,
        'm2.session.submitted',
        'bladder_diary_session',
        session.id,
        session,
        updated,
        { testBypass }
      );
      await client.query('COMMIT');
      res.json(formatDiarySession(updated));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      requireClinicalSchema(error, res, 'M2 submit');
    } finally {
      client.release();
    }
  });

  app.get('/api/patient/plan/current', authenticate, async (req, res) => {
    const client = await pool.connect();
    try {
      const enrollment = await getEnrollment(client, req.user.userId);
      if (!enrollment) return noEnrollment(res);
      const plan = await loadActivePlan(client, enrollment.id);
      if (!plan) return res.status(404).json({ error: 'Published plan not found', code: 'PLAN_NOT_FOUND' });
      const summary = planSummary(plan);
      const content = plan.currentVersion.content || {};
      res.json({
        id: plan.id,
        versionId: plan.currentVersion.id,
        versionNumber: plan.currentVersion.version_number,
        title: content.title || summary.title || 'Tedavi Planım',
        summary: content.summary || summary.summary,
        status: plan.status,
        goals: content.goals || [],
        instructions: content.instructions || [],
        parameters: content.parameters || content,
        publishedAt: plan.updated_at,
      });
    } catch (error) {
      requireClinicalSchema(error, res, 'Current plan');
    } finally {
      client.release();
    }
  });

  app.post('/api/patient/teachback/responses', authenticate, async (req, res) => {
    if (!req.body.episodeId) return res.status(400).json({ error: 'episodeId is required', code: 'VALIDATION_ERROR' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const enrollment = await getEnrollment(client, req.user.userId);
      if (!enrollment) {
        await client.query('ROLLBACK');
        return noEnrollment(res);
      }
      const episode = await client.query(
        `SELECT * FROM clinical_teachback_episodes WHERE id = $1 AND enrollment_id = $2 FOR UPDATE`,
        [req.body.episodeId, enrollment.id]
      );
      if (!episode.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Teach-back episode not found', code: 'EPISODE_NOT_FOUND' });
      }
      const key = idempotencyKey(req, { ...req.body, idempotencyKey: req.body.responseId }) || crypto.randomUUID();
      const responseId = idForKey(`${req.body.episodeId}:${key}`);
      const existing = await client.query(
        `SELECT * FROM clinical_teachback_responses WHERE id = $1 LIMIT 1`,
        [responseId]
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return res.json({
          id: episode.rows[0].id,
          planVersionId: episode.rows[0].metadata?.planVersionId || null,
          title: episode.rows[0].metadata?.title || null,
          prompts: episode.rows[0].metadata?.prompts || [],
          completedAt: episode.rows[0].completed_at || null,
        });
      }
      const response = await insertCompatible(client, 'clinical_teachback_responses', {
        id: responseId,
        enrollment_id: enrollment.id,
        patient_user_id: req.user.userId,
        episode_id: req.body.episodeId,
        teachback_episode_id: req.body.episodeId,
        prompt_key: req.body.questionId || req.body.promptKey || 'patient_response',
        response: req.body.responseData || req.body.payload || req.body.answers || { answer: req.body.answer || req.body.response },
        answer: req.body.answer,
        response_data: req.body.responseData || req.body.payload || {},
        idempotency_key: key,
        submitted_at: new Date(),
        created_at: new Date(),
      });
      await updateCompatible(client, 'clinical_teachback_episodes', req.body.episodeId, {
        state: 'completed',
        completed_at: new Date(),
        updated_at: new Date(),
      });
      await audit(client, enrollment, req.user.userId, 'teachback.response.submitted', 'teachback_response', response.id, null, response);
      await client.query('COMMIT');
      res.status(201).json({
        id: episode.rows[0].id,
        planVersionId: episode.rows[0].metadata?.planVersionId || null,
        title: episode.rows[0].metadata?.title || null,
        prompts: episode.rows[0].metadata?.prompts || [],
        completedAt: episode.rows[0].completed_at || null,
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      requireClinicalSchema(error, res, 'Teach-back response');
    } finally {
      client.release();
    }
  });

  app.get('/api/patient/m5/records', authenticate, async (req, res) => {
    const client = await pool.connect();
    try {
      const enrollment = await getEnrollment(client, req.user.userId);
      if (!enrollment) return noEnrollment(res);
      const records = await safeRows(
        client,
        `SELECT * FROM clinical_m5_records
          WHERE enrollment_id = $1
            AND record_type IN ('NATURAL_URGENCY_EVENT', 'APPLICATION_SUMMARY')
          ORDER BY recorded_at DESC`,
        [enrollment.id]
      );
      res.json({ state: 'available', records: records.map(formatM5Record), summary: null });
    } catch (error) {
      requireClinicalSchema(error, res, 'M5 records');
    } finally {
      client.release();
    }
  });

  app.post('/api/patient/m5/records', authenticate, async (req, res) => {
    const recordType = String(req.body.recordType || '').toUpperCase();
    if (!['NATURAL_URGENCY_EVENT', 'APPLICATION_SUMMARY'].includes(recordType)) {
      return res.status(400).json({ error: 'Invalid recordType', code: 'VALIDATION_ERROR' });
    }
    const key = idempotencyKey(req);
    if (!key) return res.status(400).json({ error: 'Idempotency-Key is required', code: 'IDEMPOTENCY_KEY_REQUIRED' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const enrollment = await getEnrollment(client, req.user.userId);
      if (!enrollment) {
        await client.query('ROLLBACK');
        return noEnrollment(res);
      }
      const existing = await findIdempotent(client, 'clinical_m5_records', enrollment.id, key);
      if (existing) {
        await client.query('COMMIT');
        return res.json(formatM5Record(existing));
      }
      const record = await insertCompatible(client, 'clinical_m5_records', {
        id: idForKey(key),
        app_id: enrollment.app_id,
        enrollment_id: enrollment.id,
        patient_user_id: req.user.userId,
        record_type: recordType,
        status: 'active',
        recorded_at: req.body.occurredAt ? new Date(req.body.occurredAt) : new Date(),
        values: req.body.payload || req.body.data || {
          urgency: req.body.urgency,
          outcome: req.body.outcome,
          notes: req.body.notes,
        },
        source: 'patient',
        client_event_id: req.body.clientRecordId || key,
        transport_state: 'SERVER_STORED',
        idempotency_key: key,
        metadata: {
          idempotencyKey: key,
          clientRecordId: req.body.clientRecordId || key,
          storageState: 'SERVER_STORED',
        },
        created_at: new Date(),
        updated_at: new Date(),
      });
      await audit(client, enrollment, req.user.userId, 'm5.record.created', 'patient_clinical_record', record.id, null, record);
      await client.query('COMMIT');
      res.status(201).json(formatM5Record(record));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error.code === '23505') return res.status(409).json({ error: 'Duplicate record', code: 'DUPLICATE_RECORD' });
      requireClinicalSchema(error, res, 'M5 create record');
    } finally {
      client.release();
    }
  });

  app.get('/api/patient/m6/current', authenticate, async (req, res) => {
    const client = await pool.connect();
    try {
      const enrollment = await getEnrollment(client, req.user.userId);
      if (!enrollment) return noEnrollment(res);
      const [snapshots, episodes, decisions] = await Promise.all([
        safeRows(client, `SELECT * FROM clinical_review_snapshots WHERE enrollment_id = $1 ORDER BY created_at DESC LIMIT 1`, [enrollment.id]),
        safeRows(client, `SELECT * FROM clinical_review_episodes WHERE enrollment_id = $1 ORDER BY created_at DESC LIMIT 1`, [enrollment.id]),
        safeRows(client, `SELECT * FROM clinical_decisions WHERE enrollment_id = $1 AND module_key = 'M6' ORDER BY created_at DESC LIMIT 1`, [enrollment.id]),
      ]);
      const decision = decisions[0] || null;
      const payload = decision?.payload || {};
      res.json({
        state: decision ? 'available' : 'awaiting_review',
        title: payload.title || null,
        message: payload.message || decision?.rationale || null,
        decision: decision?.decision || decision?.decision_type || null,
        decidedAt: decision?.decided_at || null,
        awaitingActivation: episodes[0]?.state === 'completed' && !decision,
        teachBack: payload.teachBack || null,
        snapshot: snapshots[0] || null,
      });
    } catch (error) {
      requireClinicalSchema(error, res, 'M6 current');
    } finally {
      client.release();
    }
  });

  app.get('/api/patient/m7/current', authenticate, async (req, res) => {
    const client = await pool.connect();
    try {
      const enrollment = await getEnrollment(client, req.user.userId);
      if (!enrollment) return noEnrollment(res);
      const orders = await safeRows(
        client,
        `SELECT * FROM clinical_activation_orders
          WHERE enrollment_id = $1
            AND state IN ('active', 'activated', 'published', 'approved')
            AND (effective_from IS NULL OR effective_from <= now())
            AND (review_due_at IS NULL OR review_due_at >= now())
          ORDER BY created_at DESC`,
        [enrollment.id]
      );
      res.json({
        state: orders.length > 0 ? 'available' : 'locked',
        title: orders.length > 0 ? 'Etkinleştirilmiş destekler' : null,
        message: orders.length > 0 ? null : 'Doktor etkinleştirmesi bekleniyor.',
        activations: orders.map((order) => {
          const rules = order.activation_rules || {};
          const metadata = order.metadata || {};
          return {
            id: order.id,
            packageCode: order.package_key || rules.packageCode || metadata.packageCode || 'M7',
            title: rules.title || metadata.title || 'Destek paketi',
            instructions: rules.instructions || metadata.instructions || [],
            activatedAt: order.activated_at,
          };
        }),
      });
    } catch (error) {
      requireClinicalSchema(error, res, 'M7 current');
    } finally {
      client.release();
    }
  });

  app.get('/api/patient/m8/current', authenticate, async (req, res) => {
    const client = await pool.connect();
    try {
      const enrollment = await getEnrollment(client, req.user.userId);
      if (!enrollment) return noEnrollment(res);
      const [decisions, sessions] = await Promise.all([
        safeRows(client, `SELECT * FROM clinical_decisions WHERE enrollment_id = $1 ORDER BY created_at DESC`, [enrollment.id]),
        safeRows(client, `SELECT cms.*, ctm.module_key FROM therapeutic_module_sessions cms JOIN therapeutic_module_registry ctm ON ctm.id = cms.therapeutic_module_id WHERE cms.enrollment_id = $1 ORDER BY cms.created_at DESC`, [enrollment.id]),
      ]);
      const handoff = decisions.find((row) =>
        String(row.decision || '').toUpperCase() === 'ROUTE_TO_M8_FINAL_REVIEW' ||
        String(row.payload?.primaryRoute || '').toUpperCase() === 'ROUTE_TO_M8_FINAL_REVIEW' ||
        String(row.module_key || '').toUpperCase() === 'M8' ||
        ['m8', 'close', 'closure', 'terminate', 'completed'].includes(
          String(row.decision_type || row.action || row.outcome || '').toLowerCase()
        )
      ) || null;
      const session = sessions.find((row) => moduleCode(row) === 'M8') || null;
      const payload = handoff?.payload || {};
      res.json({
        state: handoff || session ? (session?.state || 'available') : 'locked',
        title: payload.title || null,
        message: payload.message || handoff?.rationale || null,
        outcome: payload.outcome || handoff?.decision || null,
        closedAt: session?.completed_at || handoff?.decided_at || null,
        followUp: payload.followUp || [],
      });
    } catch (error) {
      requireClinicalSchema(error, res, 'M8 current');
    } finally {
      client.release();
    }
  });
}

module.exports = {
  getClinicalBundle,
  registerClinicalApi,
  _test: {
    formatDiaryEvent,
    idForKey,
    isMissingSchemaError,
    loadActivePlan,
    validateDiaryEventPayload,
  },
};
