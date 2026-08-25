/**
 * NaviKont 90-Day Journey Seeder
 * Reads /tmp/navikont_journey.json and seeds the PostgreSQL database.
 */

const fs = require('fs');
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const MODULE_TYPE_MAP = {
  reading:    'html_content',
  article:    'html_content',
  podcast:    'video',
  video:      'video',
  quiz:       'quiz',
  task:       'task',
  safety:     'html_content',
  optional:   'html_content',
  completion: 'html_content',
};

const MODULE_DISPLAY_NAMES = {
  1: 'Modül 1 — OAB\'yi Anlamak',
  2: 'Modül 2 — Mesane Günlüğü',
  3: 'Modül 3 — Kişisel Başlangıç Planınız',
  4: 'Modül 4 — Sıkışmayla Baş Etme Becerileri',
  5: 'Modül 5 — Gerçek Yaşamda Uygulama',
  6: 'Modül 6 — Klinisyen Değerlendirmesi',
  7: 'Modül 7 — Koşullu Destekler',
  8: 'Modül 8 — Program Kapanışı',
};

async function seed() {
  const client = await pool.connect();
  try {
    const appId = process.env.NAVIKONT_APP_ID;

    // Load the journey data built by Python
    const raw = fs.readFileSync('/tmp/navikont_journey.json', 'utf-8');
    const data = JSON.parse(raw);
    const { modules: allModules, journey } = data;

    // Get module type IDs
    const typesRes = await client.query(`SELECT id, code FROM content_module_types`);
    const typeIdByCode = {};
    for (const row of typesRes.rows) typeIdByCode[row.code] = row.id;

    // Get default app version
    const versionRes = await client.query(
      `SELECT id FROM content_app_versions WHERE app_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [appId]
    );
    const appVersionId = versionRes.rows[0].id;

    // Get or create a default journey
    let journeyId;
    const journeyRes = await client.query(
      `SELECT id FROM content_journeys WHERE app_id = $1 AND is_default = true LIMIT 1`,
      [appId]
    );
    if (journeyRes.rows.length > 0) {
      journeyId = journeyRes.rows[0].id;
      console.log(`Using existing journey: ${journeyId}`);
    } else {
      const newJourney = await client.query(
        `INSERT INTO content_journeys (id, app_id, name, description, is_default, status, duration_days)
         VALUES (gen_random_uuid(), $1, $2, $3, true, 'published', 90) RETURNING id`,
        [appId, 'Navikont 90 Günlük Program', '8 Modüllü, 90 Günlük Terapötik Yolculuk']
      );
      journeyId = newJourney.rows[0].id;
      console.log(`Created new journey: ${journeyId}`);
    }

    await client.query('BEGIN');

    // Clean existing steps for this journey
    await client.query(`DELETE FROM content_journey_steps WHERE journey_id = $1`, [journeyId]);
    console.log('Cleared existing journey steps.');

    // Delete old navikont modules (re-seed fresh)
    await client.query(`
      DELETE FROM content_module_versions 
      WHERE module_id IN (SELECT id FROM content_modules WHERE app_id = $1)
    `, [appId]);
    await client.query(`DELETE FROM content_modules WHERE app_id = $1`, [appId]);
    console.log('Cleared old modules.');

    // Create one content_module per module number
    const moduleDbIds = {}; // moduleNumber -> db uuid
    for (const modNumStr of Object.keys(allModules)) {
      const modNum = parseInt(modNumStr);
      const screens = allModules[modNumStr];
      if (!screens || screens.length === 0) continue;

      const displayName = MODULE_DISPLAY_NAMES[modNum] || `Modül ${modNum}`;
      const typeCode = 'html_content'; // main type for the module container
      const moduleTypeId = typeIdByCode[typeCode];

      const modRes = await client.query(
        `INSERT INTO content_modules (id, app_id, module_type_id, name, internal_name, description, status)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'published')
         RETURNING id`,
        [appId, moduleTypeId, displayName, `module_${modNum}`,
         `Navikont ${displayName} modülü — ${screens.length} ekran içeriği`]
      );
      moduleDbIds[modNum] = modRes.rows[0].id;

      // Build the full content JSON with all screens
      const contentJson = {
        screens: screens.map(s => ({
          id: s.id,
          title: s.title,
          text: s.text || '',
          key_message: s.key_message || '',
          expanded_text: s.expanded_text || '',
          cta: s.cta || 'Devam Et',
          type: s.type || 'reading',
          media: s.media || null,
          question_text: s.question_text || '',
          options: s.options || '',
          correct_feedback: s.correct_feedback || '',
          wrong_feedback: s.wrong_feedback || '',
        }))
      };

      await client.query(
        `INSERT INTO content_module_versions (id, module_id, app_version_id, version_number, title, content, status)
         VALUES (gen_random_uuid(), $1, $2, 1, $3, $4, 'published')`,
        [moduleDbIds[modNum], appVersionId, displayName, JSON.stringify(contentJson)]
      );

      console.log(`  Module ${modNum}: inserted with ${screens.length} screens`);
    }

    // Insert journey steps — one per screen per day
    let stepCount = 0;
    for (const dayStr of Object.keys(journey).sort((a,b) => parseInt(a)-parseInt(b))) {
      const dayNum = parseInt(dayStr);
      const dayTasks = journey[dayStr]; // array of [moduleNum, screen]

      for (let orderIdx = 0; orderIdx < dayTasks.length; orderIdx++) {
        const [moduleNum, screen] = dayTasks[orderIdx];
        const moduleDbId = moduleDbIds[moduleNum];
        if (!moduleDbId) continue;

        // Determine the screen type for module_type mapping
        const screenTypeCode = MODULE_TYPE_MAP[screen.type] || 'html_content';
        const screenTypeId = typeIdByCode[screenTypeCode];

        // Create a micro-module for this specific screen/task
        const taskName = `M${moduleNum} Gün ${dayNum} — ${screen.title.substring(0, 40)}`;
        const taskModRes = await client.query(
          `INSERT INTO content_modules (id, app_id, module_type_id, name, internal_name, description, status)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'published')
           RETURNING id`,
          [appId, screenTypeId, taskName, `${screen.id}_d${dayNum}`,
           screen.text ? screen.text.substring(0, 200) : screen.title]
        );
        const taskModuleId = taskModRes.rows[0].id;

        // Store screen content in module version
        await client.query(
          `INSERT INTO content_module_versions (id, module_id, app_version_id, version_number, title, subtitle, content, status)
           VALUES (gen_random_uuid(), $1, $2, 1, $3, $4, $5, 'published')`,
          [
            taskModuleId, appVersionId,
            screen.title,
            MODULE_DISPLAY_NAMES[moduleNum] || `Modül ${moduleNum}`,
            JSON.stringify({
              screen_id: screen.id,
              text: screen.text || '',
              key_message: screen.key_message || '',
              expanded_text: screen.expanded_text || '',
              cta: screen.cta || 'Devam Et',
              type: screen.type || 'reading',
              media: screen.media || null,
              question_text: screen.question_text || '',
              options: screen.options || '',
              correct_feedback: screen.correct_feedback || '',
              wrong_feedback: screen.wrong_feedback || '',
            })
          ]
        );

        // Insert journey step
        await client.query(
          `INSERT INTO content_journey_steps 
           (id, journey_id, module_id, day_number, order_in_day, is_required)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
          [journeyId, taskModuleId, dayNum, orderIdx + 1,
           screen.type !== 'optional']
        );

        stepCount++;
      }

      if (dayNum % 10 === 0) {
        console.log(`  Inserted up to Day ${dayNum} (${stepCount} steps so far)...`);
      }
    }

    await client.query('COMMIT');
    console.log(`\n✅ Seeding completed!`);
    console.log(`   Journey: ${journeyId}`);
    console.log(`   Total journey steps: ${stepCount}`);
    console.log(`   90 days fully populated.`);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Error during seeding:', err.message);
    console.error(err);
  } finally {
    client.release();
    pool.end();
  }
}

seed();
