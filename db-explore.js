// Database Explorer Script - discovers schema and sample data
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function explore() {
  const client = await pool.connect();
  try {
    // 1. List all tables
    console.log('\n===== ALL TABLES =====');
    const tables = await client.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name
    `);
    tables.rows.forEach(r => console.log('  ' + r.table_name));

    // 2. Check NaviKont app
    console.log('\n===== NAVIKONT APP =====');
    const app = await client.query(`SELECT * FROM content_apps WHERE id = $1`, [process.env.NAVIKONT_APP_ID]);
    console.log(JSON.stringify(app.rows, null, 2));

    // 3. App versions
    console.log('\n===== APP VERSIONS =====');
    const versions = await client.query(`SELECT * FROM content_app_versions WHERE app_id = $1 ORDER BY created_at DESC LIMIT 5`, [process.env.NAVIKONT_APP_ID]);
    console.log(JSON.stringify(versions.rows, null, 2));

    // 4. core_users sample
    console.log('\n===== USERS (sample) =====');
    const users = await client.query(`SELECT id, email, first_name, last_name, created_at FROM core_users LIMIT 5`);
    console.log(JSON.stringify(users.rows, null, 2));

    // 5. Patient enrollments
    console.log('\n===== PATIENT ENROLLMENTS =====');
    const enrollments = await client.query(`SELECT * FROM patient_app_enrollments WHERE app_id = $1 LIMIT 5`, [process.env.NAVIKONT_APP_ID]);
    console.log(JSON.stringify(enrollments.rows, null, 2));

    // 6. Journeys
    console.log('\n===== CONTENT JOURNEYS =====');
    const journeys = await client.query(`SELECT * FROM content_journeys WHERE app_id = $1`, [process.env.NAVIKONT_APP_ID]);
    console.log(JSON.stringify(journeys.rows, null, 2));

    // 7. Journey steps sample
    console.log('\n===== JOURNEY STEPS (sample) =====');
    const jSteps = await client.query(`
      SELECT cjs.* FROM content_journey_steps cjs 
      JOIN content_journeys cj ON cj.id = cjs.journey_id 
      WHERE cj.app_id = $1 
      ORDER BY cjs.day_number ASC, cjs.order_in_day ASC 
      LIMIT 15
    `, [process.env.NAVIKONT_APP_ID]);
    console.log(JSON.stringify(jSteps.rows, null, 2));

    // 8. Modules
    console.log('\n===== CONTENT MODULES =====');
    const modules = await client.query(`SELECT cm.id, cm.name, cmt.code as module_type FROM content_modules cm JOIN content_module_types cmt ON cmt.id = cm.module_type_id WHERE cm.app_id = $1 AND cm.deleted_at IS NULL LIMIT 10`, [process.env.NAVIKONT_APP_ID]);
    console.log(JSON.stringify(modules.rows, null, 2));

    // 9. Module versions
    console.log('\n===== MODULE VERSIONS (sample) =====');
    const mvs = await client.query(`
      SELECT cmv.id, cmv.module_id, cmv.title, cmv.subtitle, cmv.version_number 
      FROM content_module_versions cmv 
      JOIN content_modules cm ON cm.id = cmv.module_id 
      WHERE cm.app_id = $1 AND cm.deleted_at IS NULL LIMIT 10
    `, [process.env.NAVIKONT_APP_ID]);
    console.log(JSON.stringify(mvs.rows, null, 2));

    // 10. Questionnaires
    console.log('\n===== QUESTIONNAIRES =====');
    const quests = await client.query(`SELECT * FROM forms_questionnaires WHERE app_id = $1 LIMIT 5`, [process.env.NAVIKONT_APP_ID]);
    console.log(JSON.stringify(quests.rows, null, 2));

    // 11. Check-in templates
    console.log('\n===== CHECKIN TEMPLATES =====');
    const checkins = await client.query(`SELECT * FROM forms_checkin_templates WHERE app_id = $1 LIMIT 5`, [process.env.NAVIKONT_APP_ID]);
    console.log(JSON.stringify(checkins.rows, null, 2));

    // 12. core_users columns
    console.log('\n===== CORE_USERS COLUMNS =====');
    const userCols = await client.query(`
      SELECT column_name, data_type, is_nullable 
      FROM information_schema.columns 
      WHERE table_name = 'core_users' 
      ORDER BY ordinal_position
    `);
    console.log(JSON.stringify(userCols.rows, null, 2));

    // 13. patient_profiles
    console.log('\n===== PATIENT PROFILES (sample) =====');
    const profiles = await client.query(`SELECT * FROM patient_profiles LIMIT 3`);
    console.log(JSON.stringify(profiles.rows, null, 2));

    // 14. Check password field in core_users
    console.log('\n===== USER AUTH INFO =====');
    const authInfo = await client.query(`SELECT id, email, password_hash, status FROM core_users LIMIT 3`);
    console.log(JSON.stringify(authInfo.rows, null, 2));

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

explore();
