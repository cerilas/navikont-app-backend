/**
 * Seed OAB Daily Standard Check-in
 * 
 * Creates:
 * 1. A checkin template with 7 clinical questions (OAB daily monitoring)
 * 2. A single content_module (checkin type) referencing this template
 * 3. A journey step on every Day 1-90 (last position each day)
 */

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const APP_ID    = process.env.NAVIKONT_APP_ID;
const JOURNEY_ID = '56ba9baa-ac3a-425d-9949-1bbc60c2ba15';

// The 7 questions — stored in checkin template settings JSONB
const CHECKIN_QUESTIONS = [
  {
    id: 'daily_void_count',
    order: 1,
    label: 'Bugün gündüz kaç kez idrara çıktınız?',
    description: 'Uykudan uyanmadan önce ve uyku dönemi dışındaki işeme sayısını sayın.',
    type: 'single_choice',
    required: true,
    options: [
      { value: 'low',    label: '7 veya daha az',         score: 0 },
      { value: 'medium', label: '8 ile 12 arasında',      score: 1 },
      { value: 'high',   label: '13 veya daha fazla',     score: 2 },
    ]
  },
  {
    id: 'daily_urgency',
    order: 2,
    label: 'Bugün ani ve güçlü sıkışma hissi (ertelemesi zor) yaşadınız mı?',
    description: 'Normal işeme isteğini değil, aniden gelen ve ertelemesi güç olan sıkışmayı kasteder.',
    type: 'single_choice',
    required: true,
    options: [
      { value: 'none',   label: 'Hayır, yaşamadım',          score: 0 },
      { value: 'some',   label: 'Evet, 1-2 kez',             score: 1 },
      { value: 'many',   label: 'Evet, 3 veya daha fazla kez', score: 2 },
    ]
  },
  {
    id: 'daily_urgency_severity',
    order: 3,
    label: 'En şiddetli sıkışma hissi ne kadardı? (Navikont Ölçeği 0-4)',
    description: 'Bugünkü en güçlü sıkışma hissini tarif eden seçeneği işaretleyin.',
    type: 'single_choice',
    required: false,
    display_condition: { question_id: 'daily_urgency', not_value: 'none' },  // shown only if urgency != none
    options: [
      { value: '1', label: '1 — Hafif: Hissettim, rahatlıkla bekleyebildim',         score: 1 },
      { value: '2', label: '2 — Orta: Belirgin sıkışma, ancak tuvalete yetişebildim', score: 2 },
      { value: '3', label: '3 — Güçlü: Çok zorlandım, ama tuvalete yetişebildim',    score: 3 },
      { value: '4', label: '4 — Çok güçlü: Tuvalete yetişemeden kaçırdım',          score: 4 },
    ]
  },
  {
    id: 'daily_leakage',
    order: 4,
    label: 'Bugün idrar kaçırma yaşadınız mı?',
    description: 'Az miktarda ıslaklık da dahildir.',
    type: 'single_choice',
    required: true,
    options: [
      { value: 'none',   label: 'Hayır, kaçırma olmadı',                  score: 0 },
      { value: 'minor',  label: 'Evet, küçük miktarda (birkaç damla)',     score: 1 },
      { value: 'major',  label: 'Evet, belirgin miktarda (giysi değişimi)', score: 2 },
    ]
  },
  {
    id: 'daily_nocturia',
    order: 5,
    label: 'Gece uyku sırasında idrara kalktınız mı?',
    description: 'Gece uyku döneminizde (yataktan kalkıp tuvalete gittiğiniz kaç kez oldu?)',
    type: 'single_choice',
    required: true,
    options: [
      { value: '0',    label: 'Hiç kalkmadım',         score: 0 },
      { value: '1',    label: '1 kez',                  score: 1 },
      { value: '2',    label: '2 kez',                  score: 2 },
      { value: '3+',   label: '3 veya daha fazla kez',  score: 3 },
    ]
  },
  {
    id: 'daily_plan_adherence',
    order: 6,
    label: 'Bugün programdaki görevinizi/egzersizinizi uyguladınız mı?',
    description: 'Bugün için size atanan egzersiz, okuma veya görev kastedilmektedir.',
    type: 'single_choice',
    required: true,
    options: [
      { value: 'full',    label: 'Evet, tamamladım',                   score: 2 },
      { value: 'partial', label: 'Kısmen uyguladım',                   score: 1 },
      { value: 'none',    label: 'Hayır, bugün uygulayamadım',         score: 0 },
    ]
  },
  {
    id: 'daily_wellbeing',
    order: 7,
    label: 'Bugün kendinizi genel olarak nasıl hissettiniz?',
    description: 'Mesane belirtilerinizden bağımsız olarak genel ruh haliniz ve enerjiniz.',
    type: 'single_choice',
    required: true,
    options: [
      { value: '1', label: '😞  Çok kötü',   score: 1 },
      { value: '2', label: '😕  Kötü',        score: 2 },
      { value: '3', label: '😐  Orta',        score: 3 },
      { value: '4', label: '🙂  İyi',         score: 4 },
      { value: '5', label: '😊  Çok iyi',     score: 5 },
    ]
  },
];

async function seed() {
  const client = await pool.connect();
  try {
    // ── Lookups ────────────────────────────────────────────────────────────
    const versionRes = await client.query(
      `SELECT id FROM content_app_versions WHERE app_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [APP_ID]
    );
    const APP_VERSION_ID = versionRes.rows[0].id;

    const checkinTypeRes = await client.query(
      `SELECT id FROM content_module_types WHERE code='checkin'`
    );
    const CHECKIN_TYPE_ID = checkinTypeRes.rows[0].id;

    console.log('App version:', APP_VERSION_ID);
    console.log('Checkin type id:', CHECKIN_TYPE_ID);

    await client.query('BEGIN');

    // ══════════════════════════════════════════════════════════════════════
    // STEP 1 — Create / Replace the checkin template
    // ══════════════════════════════════════════════════════════════════════
    console.log('\n[1/4] Creating OAB daily standard checkin template...');

    await client.query(
      `DELETE FROM forms_checkin_templates WHERE app_id=$1 AND name=$2`,
      [APP_ID, 'OAB Günlük Standart Takip']
    );

    const templateRes = await client.query(
      `INSERT INTO forms_checkin_templates
         (id, app_id, name, description, frequency, streak_enabled, settings, status)
       VALUES (gen_random_uuid(), $1, $2, $3, 'daily', true, $4, 'published')
       RETURNING id`,
      [
        APP_ID,
        'OAB Günlük Standart Takip',
        'Her gün otomatik olarak eklenen standart OAB izleme check-ini. İşeme, urgency, kaçırma, noktüri, plan uyumu ve wellbeing verisi toplar.',
        JSON.stringify({
          intro_title: 'Günlük Takip',
          intro_text:  'Bugünü kısa bir değerlendirmeyle kapatalım. Bu 2 dakikalık kontrol, doktorunuzun ilerlemenizi izlemesine yardımcı olur.',
          completion_message: 'Kaydınız alındı. Yarın görüşürüz! 👋',
          questions: CHECKIN_QUESTIONS,
          scoring: {
            method: 'sum',
            fields: ['daily_void_count', 'daily_urgency', 'daily_urgency_severity', 'daily_leakage', 'daily_nocturia'],
            label: 'OAB Günlük Semptom Skoru',
            max: 14,
            note: 'Yalnızca semptom sorularından (S1-S5) hesaplanır. Klinik tanı veya yorum içermez.'
          },
          clinical_note: 'Bu veriler klinik yorum içermez. Otomatik tanı, triyaj veya tedavi önerisi üretilmez. Veriler yalnızca klinisyen takibi ve program etkinliği değerlendirmesi için kaydedilir.',
        })
      ]
    );
    const TEMPLATE_ID = templateRes.rows[0].id;
    console.log('  ✅ Template created:', TEMPLATE_ID);

    // ══════════════════════════════════════════════════════════════════════
    // STEP 2 — Create a single content_module wrapping this checkin
    // ══════════════════════════════════════════════════════════════════════
    console.log('\n[2/4] Creating checkin content module...');

    await client.query(
      `DELETE FROM content_module_versions WHERE title=$1`,
      ['Günlük OAB Takip Check-in']
    );
    await client.query(
      `DELETE FROM content_modules WHERE internal_name=$1`,
      ['oab_daily_standard_checkin']
    );

    const moduleRes = await client.query(
      `INSERT INTO content_modules (id, app_id, module_type_id, name, internal_name, description, status)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'published')
       RETURNING id`,
      [
        APP_ID, CHECKIN_TYPE_ID,
        'Günlük OAB Takip Check-in',
        'oab_daily_standard_checkin',
        '90 günlük program boyunca her gün eklenen standart OAB izleme soruları (7 soru, ~2 dk)'
      ]
    );
    const MODULE_ID = moduleRes.rows[0].id;

    await client.query(
      `INSERT INTO content_module_versions
         (id, module_id, app_version_id, version_number, title, subtitle, content, status)
       VALUES (gen_random_uuid(), $1, $2, 1, $3, $4, $5, 'published')`,
      [
        MODULE_ID, APP_VERSION_ID,
        'Günlük OAB Takip Check-in',
        'Günlük 2 dakikalık mesane takip kaydı',
        JSON.stringify({
          checkinTemplateId: TEMPLATE_ID,
          type:              'daily_oab_checkin',
          estimated_minutes: 2,
          intro_title:       'Günün Sonu Kontrolü',
          intro_text:        'Bugünü kısa bir değerlendirmeyle kapatalım. Bu sorular doktorunuzun ilerlemenizi izlemesine yardımcı olur.',
          icon:              'clipboard-check',
          // Questions embedded directly for iOS rendering (no separate API call needed)
          questions:         CHECKIN_QUESTIONS,
          scoring: {
            method: 'sum',
            symptom_fields: ['daily_void_count', 'daily_urgency', 'daily_urgency_severity', 'daily_leakage', 'daily_nocturia'],
            max_symptom_score: 14,
          }
        })
      ]
    );
    console.log('  ✅ Module created:', MODULE_ID);

    // ══════════════════════════════════════════════════════════════════════
    // STEP 3 — Remove any existing daily checkin steps (clean slate)
    // ══════════════════════════════════════════════════════════════════════
    console.log('\n[3/4] Removing old daily checkin steps if any...');
    const delRes = await client.query(
      `DELETE FROM content_journey_steps
       WHERE journey_id=$1 AND module_id=$2`,
      [JOURNEY_ID, MODULE_ID]
    );
    console.log('  Removed:', delRes.rowCount, 'old steps');

    // ══════════════════════════════════════════════════════════════════════
    // STEP 4 — Add checkin as last step of every Day 1-90
    // ══════════════════════════════════════════════════════════════════════
    console.log('\n[4/4] Adding checkin to Days 1-90...');

    // Get current max order_in_day per day
    const maxOrderRes = await client.query(
      `SELECT day_number, MAX(order_in_day) AS max_order
       FROM content_journey_steps
       WHERE journey_id=$1 AND day_number BETWEEN 1 AND 90
       GROUP BY day_number
       ORDER BY day_number`,
      [JOURNEY_ID]
    );

    const maxOrderByDay = {};
    maxOrderRes.rows.forEach(r => { maxOrderByDay[r.day_number] = parseInt(r.max_order); });

    let added = 0;
    const insertValues = [];
    for (let day = 1; day <= 90; day++) {
      const nextOrder = (maxOrderByDay[day] || 0) + 1;
      insertValues.push(`(gen_random_uuid(), '${JOURNEY_ID}', '${MODULE_ID}', ${day}, ${nextOrder}, false)`);
      added++;
    }

    // Batch insert all 90 steps at once
    await client.query(
      `INSERT INTO content_journey_steps (id, journey_id, module_id, day_number, order_in_day, is_required)
       VALUES ${insertValues.join(',\n')}`
    );

    await client.query('COMMIT');

    console.log(`\n✅ Done! Added ${added} daily checkin steps (Day 1-90)`);
    console.log('');
    console.log('Summary:');
    console.log('  Template ID:', TEMPLATE_ID);
    console.log('  Module ID:  ', MODULE_ID);
    console.log('  Questions:  ', CHECKIN_QUESTIONS.length);
    console.log('  Days:       ', added);
    console.log('  Required:    No (patient can skip, system will nudge)');
    console.log('');
    console.log('Data collected per day:');
    CHECKIN_QUESTIONS.forEach(q => console.log(`  [${q.id}] ${q.label.substring(0,60)}`));

    // Verify
    const verify = await client.query(
      `SELECT day_number, order_in_day FROM content_journey_steps
       WHERE journey_id=$1 AND module_id=$2
       ORDER BY day_number LIMIT 5`,
      [JOURNEY_ID, MODULE_ID]
    );
    console.log('\nFirst 5 checkin steps:');
    verify.rows.forEach(r => console.log(`  Day ${r.day_number}, step ${r.order_in_day}`));

    const total = await client.query(
      `SELECT COUNT(*) FROM content_journey_steps WHERE journey_id=$1`,
      [JOURNEY_ID]
    );
    console.log(`\nTotal journey steps (including Day 0): ${total.rows[0].count}`);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Error:', err.message, err);
  } finally {
    client.release();
    pool.end();
  }
}

seed();
