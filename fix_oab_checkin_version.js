/**
 * fix_oab_checkin_version.js
 *
 * The OAB template was created by seed_daily_checkin.js but its
 * forms_checkin_template_versions and forms_checkin_fields rows were
 * never inserted.  This script adds them so the GET /api/patient/checkins/:id
 * endpoint can find the template and return the 7 clinical questions.
 */

require('dotenv').config();
const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const APP_ID     = process.env.NAVIKONT_APP_ID || '3ee42ade-0563-4eae-9c37-65b878667446';
const TEMPLATE_NAME = 'OAB Günlük Standart Takip';

// ──────────────────────────────────────────────────────────────────────────────
// The 7 clinical questions (same as seed_daily_checkin.js)
// ──────────────────────────────────────────────────────────────────────────────
const CHECKIN_QUESTIONS = [
  {
    id: 'daily_void_count',
    order: 1,
    label: 'Bugün gündüz kaç kez idrara çıktınız?',
    description: 'Uykudan uyanmadan önce ve uyku dönemi dışındaki işeme sayısını sayın.',
    type: 'single_choice',
    required: true,
    options: [
      { value: 'low',    label: '7 veya daha az' },
      { value: 'medium', label: '8 ile 12 arasında' },
      { value: 'high',   label: '13 veya daha fazla' },
    ],
  },
  {
    id: 'daily_urgency',
    order: 2,
    label: 'Bugün ani ve güçlü sıkışma hissi (ertelemesi zor) yaşadınız mı?',
    description: 'Normal işeme isteğini değil, aniden gelen ve ertelemesi güç olan sıkışmayı kasteder.',
    type: 'single_choice',
    required: true,
    options: [
      { value: 'none',   label: 'Hayır, yaşamadım' },
      { value: 'some',   label: 'Evet, 1-2 kez' },
      { value: 'many',   label: 'Evet, 3 veya daha fazla kez' },
    ],
  },
  {
    id: 'daily_urgency_severity',
    order: 3,
    label: 'En şiddetli sıkışma hissi ne kadardı? (Navikont Ölçeği 0-4)',
    description: 'Bugünkü en güçlü sıkışma hissini tarif eden seçeneği işaretleyin.',
    type: 'single_choice',
    required: false,
    options: [
      { value: '1', label: '1 — Hafif: Hissettim, rahatlıkla bekleyebildim' },
      { value: '2', label: '2 — Orta: Belirgin sıkışma, ancak tuvalete yetişebildim' },
      { value: '3', label: '3 — Güçlü: Çok zorlandım, ama tuvalete yetişebildim' },
      { value: '4', label: '4 — Çok güçlü: Tuvalete yetişemeden kaçırdım' },
    ],
  },
  {
    id: 'daily_leakage',
    order: 4,
    label: 'Bugün idrar kaçırma yaşadınız mı?',
    description: 'Az miktarda ıslaklık da dahildir.',
    type: 'single_choice',
    required: true,
    options: [
      { value: 'none',   label: 'Hayır, kaçırma olmadı' },
      { value: 'minor',  label: 'Evet, küçük miktarda (birkaç damla)' },
      { value: 'major',  label: 'Evet, belirgin miktarda (giysi değişimi)' },
    ],
  },
  {
    id: 'daily_nocturia',
    order: 5,
    label: 'Gece uyku sırasında idrara kalktınız mı?',
    description: 'Gece uyku döneminizde kaç kez tuvalete gittiğinizi belirtin.',
    type: 'single_choice',
    required: true,
    options: [
      { value: '0',  label: 'Hiç kalkmadım' },
      { value: '1',  label: '1 kez' },
      { value: '2',  label: '2 kez' },
      { value: '3+', label: '3 veya daha fazla kez' },
    ],
  },
  {
    id: 'daily_plan_adherence',
    order: 6,
    label: 'Bugün programdaki görevinizi/egzersizinizi uyguladınız mı?',
    description: 'Bugün için atanan egzersiz, okuma veya görevi kasteder.',
    type: 'single_choice',
    required: true,
    options: [
      { value: 'full',    label: 'Evet, tamamladım' },
      { value: 'partial', label: 'Kısmen uyguladım' },
      { value: 'none',    label: 'Hayır, bugün uygulayamadım' },
    ],
  },
  {
    id: 'daily_wellbeing',
    order: 7,
    label: 'Bugün kendinizi genel olarak nasıl hissettiniz?',
    description: 'Mesane belirtilerinizden bağımsız olarak genel ruh haliniz ve enerjiniz.',
    type: 'single_choice',
    required: true,
    options: [
      { value: '1', label: '😞  Çok kötü' },
      { value: '2', label: '😕  Kötü' },
      { value: '3', label: '😐  Orta' },
      { value: '4', label: '🙂  İyi' },
      { value: '5', label: '😊  Çok iyi' },
    ],
  },
];

async function fix() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── 1. Locate the existing template ───────────────────────────────────
    const tmplRes = await client.query(
      `SELECT id FROM forms_checkin_templates WHERE name = $1 AND app_id = $2 LIMIT 1`,
      [TEMPLATE_NAME, APP_ID],
    );

    if (tmplRes.rows.length === 0) {
      console.error(`❌ Template "${TEMPLATE_NAME}" not found for app ${APP_ID}.`);
      console.error('   Run seed_daily_checkin.js first, then re-run this script.');
      await client.query('ROLLBACK');
      return;
    }

    const TEMPLATE_ID = tmplRes.rows[0].id;
    console.log('✅ Found template:', TEMPLATE_ID);

    // ── 2. Check if a version already exists ──────────────────────────────
    const existingVersion = await client.query(
      `SELECT id FROM forms_checkin_template_versions
       WHERE checkin_template_id = $1
       ORDER BY version_number DESC LIMIT 1`,
      [TEMPLATE_ID],
    );

    let VERSION_ID;

    if (existingVersion.rows.length > 0) {
      VERSION_ID = existingVersion.rows[0].id;
      console.log('ℹ️  Version already exists:', VERSION_ID, '— skipping version insert.');
    } else {
      // ── 3. Create version ─────────────────────────────────────────────
      const versionRes = await client.query(
        `INSERT INTO forms_checkin_template_versions
           (id, checkin_template_id, version_number, title, status)
         VALUES (gen_random_uuid(), $1, 1, $2, 'published')
         RETURNING id`,
        [TEMPLATE_ID, TEMPLATE_NAME],
      );
      VERSION_ID = versionRes.rows[0].id;
      console.log('✅ Version created:', VERSION_ID);
    }

    // ── 4. Delete old fields for this version and re-insert ───────────────
    const delRes = await client.query(
      `DELETE FROM forms_checkin_fields WHERE checkin_template_version_id = $1`,
      [VERSION_ID],
    );
    console.log(`   Removed ${delRes.rowCount} old field(s).`);

    // ── 5. Insert fields (options stored in validation_rules JSONB) ────────
    console.log(`\n[5/5] Inserting ${CHECKIN_QUESTIONS.length} fields...`);
    for (const q of CHECKIN_QUESTIONS) {
      await client.query(
        `INSERT INTO forms_checkin_fields
           (id, checkin_template_version_id, field_key, field_type,
            label, is_required, sort_order, validation_rules)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)`,
        [
          VERSION_ID,
          q.id,
          q.type,
          q.label,
          q.required,
          q.order,
          JSON.stringify({
            description: q.description,
            options: q.options,
          }),
        ],
      );
      console.log(`   ✓ ${q.id}`);
    }

    await client.query('COMMIT');

    console.log('\n✅ Done!');
    console.log('   Template ID:', TEMPLATE_ID);
    console.log('   Version ID: ', VERSION_ID);
    console.log('   Fields:     ', CHECKIN_QUESTIONS.length);
    console.log('\nRestart the backend server to pick up the changes.');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Error:', err.message);
    console.error(err);
  } finally {
    client.release();
    pool.end();
  }
}

fix();
