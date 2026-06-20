require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function explore3() {
  const client = await pool.connect();
  try {
    // core_users columns
    console.log('===== CORE_USERS COLUMNS =====');
    const cols = await client.query(`
      SELECT column_name, data_type FROM information_schema.columns 
      WHERE table_name = 'core_users' ORDER BY ordinal_position
    `);
    cols.rows.forEach(r => console.log(`  ${r.column_name} (${r.data_type})`));

    // Users
    console.log('\n===== USERS =====');
    const users = await client.query(`SELECT * FROM core_users LIMIT 5`);
    console.log(JSON.stringify(users.rows, null, 2));

    // Enrollments
    console.log('\n===== ENROLLMENTS =====');
    const enrollments = await client.query(`SELECT * FROM patient_app_enrollments WHERE app_id = $1`, [process.env.NAVIKONT_APP_ID]);
    console.log(JSON.stringify(enrollments.rows, null, 2));

    // Journey steps detail
    console.log('\n===== JOURNEY STEPS DETAIL =====');
    const steps = await client.query(`
      SELECT cjs.id, cjs.journey_id, cjs.day_number, cjs.order_in_day, cjs.step_type, 
             cjs.title, cjs.description, cjs.module_version_id, cjs.questionnaire_version_id,
             cjs.checkin_template_version_id, cjs.is_required, cjs.time_window_start, cjs.time_window_end
      FROM content_journey_steps cjs 
      JOIN content_journeys cj ON cj.id = cjs.journey_id 
      WHERE cj.app_id = $1 
      ORDER BY cjs.day_number ASC, cjs.order_in_day ASC
    `, [process.env.NAVIKONT_APP_ID]);
    console.log(JSON.stringify(steps.rows, null, 2));

    // Questionnaire versions
    console.log('\n===== QUESTIONNAIRE VERSIONS =====');
    const qvs = await client.query(`
      SELECT fqv.* FROM forms_questionnaire_versions fqv
      JOIN forms_questionnaires fq ON fq.id = fqv.questionnaire_id
      WHERE fq.app_id = $1
    `, [process.env.NAVIKONT_APP_ID]);
    console.log(JSON.stringify(qvs.rows, null, 2));

    // Questions sample
    console.log('\n===== QUESTIONS (sample for first questionnaire version) =====');
    if (qvs.rows.length > 0) {
      const questions = await client.query(`
        SELECT * FROM forms_questions 
        WHERE questionnaire_version_id = $1 
        ORDER BY sort_order ASC
      `, [qvs.rows[0].id]);
      console.log(JSON.stringify(questions.rows, null, 2));
    }

    // Checkin template versions  
    console.log('\n===== CHECKIN TEMPLATE VERSIONS =====');
    const ctvs = await client.query(`
      SELECT fctv.* FROM forms_checkin_template_versions fctv
      JOIN forms_checkin_templates fct ON fct.id = fctv.checkin_template_id
      WHERE fct.app_id = $1
    `, [process.env.NAVIKONT_APP_ID]);
    console.log(JSON.stringify(ctvs.rows, null, 2));

    // Checkin fields
    console.log('\n===== CHECKIN FIELDS =====');
    if (ctvs.rows.length > 0) {
      const fields = await client.query(`
        SELECT * FROM forms_checkin_fields 
        WHERE checkin_template_version_id = $1 
        ORDER BY sort_order ASC
      `, [ctvs.rows[0].id]);
      console.log(JSON.stringify(fields.rows, null, 2));
    }

    // Question options
    console.log('\n===== QUESTION OPTIONS (sample) =====');
    const opts = await client.query(`SELECT * FROM forms_question_options LIMIT 20`);
    console.log(JSON.stringify(opts.rows, null, 2));

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

explore3();
