require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function explore2() {
  const client = await pool.connect();
  try {
    // 1. core_users columns
    console.log('\n===== CORE_USERS COLUMNS =====');
    const userCols = await client.query(`
      SELECT column_name, data_type FROM information_schema.columns 
      WHERE table_name = 'core_users' ORDER BY ordinal_position
    `);
    userCols.rows.forEach(r => console.log(`  ${r.column_name} (${r.data_type})`));

    // 2. Sample users
    console.log('\n===== USERS (sample) =====');
    const users = await client.query(`SELECT * FROM core_users LIMIT 3`);
    console.log(JSON.stringify(users.rows, null, 2));

    // 3. patient_app_enrollments columns
    console.log('\n===== ENROLLMENT COLUMNS =====');
    const eCols = await client.query(`
      SELECT column_name, data_type FROM information_schema.columns 
      WHERE table_name = 'patient_app_enrollments' ORDER BY ordinal_position
    `);
    eCols.rows.forEach(r => console.log(`  ${r.column_name} (${r.data_type})`));

    // 4. Sample enrollments
    console.log('\n===== ENROLLMENTS =====');
    const enrollments = await client.query(`SELECT * FROM patient_app_enrollments WHERE app_id = $1 LIMIT 3`, [process.env.NAVIKONT_APP_ID]);
    console.log(JSON.stringify(enrollments.rows, null, 2));

    // 5. content_journey_steps columns
    console.log('\n===== JOURNEY STEP COLUMNS =====');
    const jsCols = await client.query(`
      SELECT column_name, data_type FROM information_schema.columns 
      WHERE table_name = 'content_journey_steps' ORDER BY ordinal_position
    `);
    jsCols.rows.forEach(r => console.log(`  ${r.column_name} (${r.data_type})`));

    // 6. Journey steps
    console.log('\n===== JOURNEY STEPS =====');
    const steps = await client.query(`
      SELECT cjs.* FROM content_journey_steps cjs 
      JOIN content_journeys cj ON cj.id = cjs.journey_id 
      WHERE cj.app_id = $1 
      ORDER BY cjs.day_number ASC, cjs.order_in_day ASC LIMIT 10
    `, [process.env.NAVIKONT_APP_ID]);
    console.log(JSON.stringify(steps.rows, null, 2));

    // 7. Module types
    console.log('\n===== MODULE TYPES =====');
    const types = await client.query(`SELECT * FROM content_module_types`);
    console.log(JSON.stringify(types.rows, null, 2));

    // 8. Modules with versions
    console.log('\n===== MODULES WITH VERSIONS =====');
    const mods = await client.query(`
      SELECT cm.id, cm.name, cmt.code as module_type, 
             cmv.id as version_id, cmv.title, cmv.subtitle, cmv.content, cmv.settings
      FROM content_modules cm 
      JOIN content_module_types cmt ON cmt.id = cm.module_type_id
      LEFT JOIN content_module_versions cmv ON cmv.module_id = cm.id
      WHERE cm.app_id = $1 AND cm.deleted_at IS NULL 
      LIMIT 10
    `, [process.env.NAVIKONT_APP_ID]);
    console.log(JSON.stringify(mods.rows, null, 2));

    // 9. Questionnaires with questions
    console.log('\n===== QUESTIONNAIRES =====');
    const quests = await client.query(`SELECT * FROM forms_questionnaires WHERE app_id = $1`, [process.env.NAVIKONT_APP_ID]);
    console.log(JSON.stringify(quests.rows, null, 2));

    // 10. Check-in templates
    console.log('\n===== CHECKIN TEMPLATES =====');
    const checkins = await client.query(`SELECT * FROM forms_checkin_templates WHERE app_id = $1`, [process.env.NAVIKONT_APP_ID]);
    console.log(JSON.stringify(checkins.rows, null, 2));

    // 11. patient_profiles columns
    console.log('\n===== PATIENT PROFILE COLUMNS =====');
    const ppCols = await client.query(`
      SELECT column_name, data_type FROM information_schema.columns 
      WHERE table_name = 'patient_profiles' ORDER BY ordinal_position
    `);
    ppCols.rows.forEach(r => console.log(`  ${r.column_name} (${r.data_type})`));

    // 12. patient_module_progress columns
    console.log('\n===== MODULE PROGRESS COLUMNS =====');
    const mpCols = await client.query(`
      SELECT column_name, data_type FROM information_schema.columns 
      WHERE table_name = 'patient_module_progress' ORDER BY ordinal_position
    `);
    mpCols.rows.forEach(r => console.log(`  ${r.column_name} (${r.data_type})`));

    // 13. content_journeys
    console.log('\n===== JOURNEYS =====');
    const journeys = await client.query(`SELECT * FROM content_journeys WHERE app_id = $1`, [process.env.NAVIKONT_APP_ID]);
    console.log(JSON.stringify(journeys.rows, null, 2));

    // 14. Badges
    console.log('\n===== BADGES =====');
    const badges = await client.query(`SELECT * FROM content_badges WHERE app_id = $1`, [process.env.NAVIKONT_APP_ID]);
    console.log(JSON.stringify(badges.rows, null, 2));

    // 15. Notification templates
    console.log('\n===== NOTIFICATION TEMPLATES =====');
    const notifs = await client.query(`SELECT * FROM content_notification_templates WHERE app_id = $1`, [process.env.NAVIKONT_APP_ID]);
    console.log(JSON.stringify(notifs.rows, null, 2));

    // 16. Consent documents
    console.log('\n===== CONSENT DOCUMENTS =====');
    const consents = await client.query(`SELECT * FROM core_consent_documents LIMIT 5`);
    console.log(JSON.stringify(consents.rows, null, 2));

    // 17. content_app_version_modules
    console.log('\n===== APP VERSION MODULES =====');
    const avms = await client.query(`SELECT * FROM content_app_version_modules LIMIT 10`);
    console.log(JSON.stringify(avms.rows, null, 2));

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

explore2();
