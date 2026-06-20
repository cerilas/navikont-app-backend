require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function explore4() {
  const client = await pool.connect();
  try {
    // Journey steps columns
    console.log('===== JOURNEY STEP COLUMNS =====');
    const jsCols = await client.query(`
      SELECT column_name, data_type FROM information_schema.columns 
      WHERE table_name = 'content_journey_steps' ORDER BY ordinal_position
    `);
    jsCols.rows.forEach(r => console.log(`  ${r.column_name} (${r.data_type})`));

    // Journey steps data
    console.log('\n===== ALL JOURNEY STEPS =====');
    const steps = await client.query(`
      SELECT * FROM content_journey_steps 
      WHERE journey_id = '56ba9baa-ac3a-425d-9949-1bbc60c2ba15' 
      ORDER BY day_number ASC, order_in_day ASC
    `);
    console.log(JSON.stringify(steps.rows, null, 2));

    // patient_questionnaire_responses columns
    console.log('\n===== QUESTIONNAIRE RESPONSE COLUMNS =====');
    const qrCols = await client.query(`
      SELECT column_name, data_type FROM information_schema.columns 
      WHERE table_name = 'patient_questionnaire_responses' ORDER BY ordinal_position
    `);
    qrCols.rows.forEach(r => console.log(`  ${r.column_name} (${r.data_type})`));

    // patient_questionnaire_answers columns
    console.log('\n===== QUESTIONNAIRE ANSWER COLUMNS =====');
    const qaCols = await client.query(`
      SELECT column_name, data_type FROM information_schema.columns 
      WHERE table_name = 'patient_questionnaire_answers' ORDER BY ordinal_position
    `);
    qaCols.rows.forEach(r => console.log(`  ${r.column_name} (${r.data_type})`));

    // patient_checkin_submissions columns
    console.log('\n===== CHECKIN SUBMISSION COLUMNS =====');
    const csCols = await client.query(`
      SELECT column_name, data_type FROM information_schema.columns 
      WHERE table_name = 'patient_checkin_submissions' ORDER BY ordinal_position
    `);
    csCols.rows.forEach(r => console.log(`  ${r.column_name} (${r.data_type})`));

    // patient_checkin_values columns
    console.log('\n===== CHECKIN VALUE COLUMNS =====');
    const cvCols = await client.query(`
      SELECT column_name, data_type FROM information_schema.columns 
      WHERE table_name = 'patient_checkin_values' ORDER BY ordinal_position
    `);
    cvCols.rows.forEach(r => console.log(`  ${r.column_name} (${r.data_type})`));

    // patient_streaks columns
    console.log('\n===== STREAK COLUMNS =====');
    const stCols = await client.query(`
      SELECT column_name, data_type FROM information_schema.columns 
      WHERE table_name = 'patient_streaks' ORDER BY ordinal_position
    `);
    stCols.rows.forEach(r => console.log(`  ${r.column_name} (${r.data_type})`));

    // Questionnaire versions
    console.log('\n===== QUESTIONNAIRE VERSIONS =====');
    const qvs = await client.query(`
      SELECT fqv.id, fqv.questionnaire_id, fqv.version_number, fqv.title, fqv.status,
             fqv.scoring_method, fqv.risk_rules
      FROM forms_questionnaire_versions fqv
      JOIN forms_questionnaires fq ON fq.id = fqv.questionnaire_id
      WHERE fq.app_id = $1 AND fq.status = 'published'
    `, [process.env.NAVIKONT_APP_ID]);
    console.log(JSON.stringify(qvs.rows, null, 2));

    // Questions for published questionnaire
    if (qvs.rows.length > 0) {
      console.log('\n===== QUESTIONS FOR PUBLISHED QUESTIONNAIRE =====');
      const questions = await client.query(`
        SELECT * FROM forms_questions 
        WHERE questionnaire_version_id = $1 
        ORDER BY sort_order ASC
      `, [qvs.rows[0].id]);
      console.log(JSON.stringify(questions.rows, null, 2));

      // Options for first question
      if (questions.rows.length > 0) {
        console.log('\n===== OPTIONS FOR FIRST QUESTION =====');
        const opts = await client.query(`
          SELECT * FROM forms_question_options 
          WHERE question_id = $1 
          ORDER BY sort_order ASC
        `, [questions.rows[0].id]);
        console.log(JSON.stringify(opts.rows, null, 2));
      }
    }

    // Checkin template versions
    console.log('\n===== PUBLISHED CHECKIN TEMPLATE VERSIONS =====');
    const ctvs = await client.query(`
      SELECT fctv.* FROM forms_checkin_template_versions fctv
      JOIN forms_checkin_templates fct ON fct.id = fctv.checkin_template_id
      WHERE fct.app_id = $1 AND fct.status = 'published'
    `, [process.env.NAVIKONT_APP_ID]);
    console.log(JSON.stringify(ctvs.rows, null, 2));

    // Checkin fields
    if (ctvs.rows.length > 0) {
      console.log('\n===== CHECKIN FIELDS =====');
      const fields = await client.query(`
        SELECT * FROM forms_checkin_fields 
        WHERE checkin_template_version_id = $1 
        ORDER BY sort_order ASC
      `, [ctvs.rows[0].id]);
      console.log(JSON.stringify(fields.rows, null, 2));
    }

    // patient_risk_alerts columns
    console.log('\n===== RISK ALERT COLUMNS =====');
    const raCols = await client.query(`
      SELECT column_name, data_type FROM information_schema.columns 
      WHERE table_name = 'patient_risk_alerts' ORDER BY ordinal_position
    `);
    raCols.rows.forEach(r => console.log(`  ${r.column_name} (${r.data_type})`));

    // patient_notifications columns
    console.log('\n===== NOTIFICATION COLUMNS =====');
    const nCols = await client.query(`
      SELECT column_name, data_type FROM information_schema.columns 
      WHERE table_name = 'patient_notifications' ORDER BY ordinal_position
    `);
    nCols.rows.forEach(r => console.log(`  ${r.column_name} (${r.data_type})`));

    // patient_measurements columns
    console.log('\n===== MEASUREMENT COLUMNS =====');
    const mCols = await client.query(`
      SELECT column_name, data_type FROM information_schema.columns 
      WHERE table_name = 'patient_measurements' ORDER BY ordinal_position
    `);
    mCols.rows.forEach(r => console.log(`  ${r.column_name} (${r.data_type})`));

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

explore4();
