require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const APP_ID = '3ee42ade-0563-4eae-9c37-65b878667446';
async function getActiveEnrollment(client, patientUserId) {
  const result = await client.query(
    `SELECT * FROM patient_app_enrollments
     WHERE patient_user_id = $1 AND app_id = $2 AND status = 'active'
     ORDER BY created_at DESC LIMIT 1`,
    [patientUserId, APP_ID]
  );
  return result.rows[0];
}

async function test() {
  const client = await pool.connect();
  try {
    const user = await client.query(`SELECT * FROM core_users WHERE email = 'deniz@cerilas.com'`);
    const u = user.rows[0];
    const userId = u.id;
    
    const questionnaireVersionId = "52ca64a6-c20f-4069-a5b2-094a8417ed50";
    const answers = [
      {
        questionId: "6cc84025-f791-4984-a9ee-5221b710268e",
        answerValue: "opt_0",
        score: 0
      }
    ];

    await client.query('BEGIN');

    const enrollment = await getActiveEnrollment(client, userId);
    if (!enrollment) {
      console.log('No enrollment'); return;
    }

    let totalScore = 0;
    for (const answer of answers) {
      if (answer.score !== undefined && answer.score !== null) {
        totalScore += answer.score;
      }
    }

    const qvResult = await client.query(
      `SELECT id, scoring_method, risk_rules FROM forms_questionnaire_versions 
       WHERE (id = $1 OR questionnaire_id = $1)
         AND status = 'published'
       ORDER BY version_number DESC LIMIT 1`,
      [questionnaireVersionId]
    );

    let resolvedVersionId = questionnaireVersionId;
    let riskLevel = 'low';
    if (qvResult.rows.length > 0) {
      resolvedVersionId = qvResult.rows[0].id;
    }

    const responseResult = await client.query(
      `INSERT INTO patient_questionnaire_responses
         (enrollment_id, patient_user_id, app_id, app_version_id,
          questionnaire_version_id, status, total_score, risk_level, submitted_at, metadata)
       VALUES ($1, $2, $3, $4, $5, 'completed', $6, $7, NOW(), $8)
       RETURNING *`,
      [
        enrollment.id,
        userId,
        APP_ID,
        enrollment.app_version_id,
        resolvedVersionId,
        totalScore,
        riskLevel,
        JSON.stringify({ answeredAt: new Date().toISOString() }),
      ]
    );

    const responseId = responseResult.rows[0].id;

    for (const answer of answers) {
      await client.query(
        `INSERT INTO patient_questionnaire_answers
           (response_id, question_id, answer_value, score, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [
          responseId,
          answer.questionId,
          JSON.stringify(answer.answerValue),
          answer.score || 0,
        ]
      );
    }
    await client.query('ROLLBACK');
    console.log("SUCCESS!");

  } catch(e) {
    console.error("ERROR:", e);
    await client.query('ROLLBACK');
  } finally {
    client.release();
    pool.end();
  }
}
test();
