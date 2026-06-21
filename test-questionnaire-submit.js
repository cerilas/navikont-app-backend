require('dotenv').config();
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function test() {
  const client = await pool.connect();
  try {
    const user = await client.query(`SELECT * FROM core_users WHERE email = 'deniz@cerilas.com'`);
    const u = user.rows[0];
    
    const token = jwt.sign(
      { userId: u.id, email: u.email, userType: u.user_type },
      process.env.JWT_SECRET,
      { expiresIn: '1d' }
    );
    
    const questionnaireVersionId = '93c3992c-77fd-48bf-8a97-9d3355469cf1';
    const payload = {
       answers: [
         { questionId: '82dbff9a-dc8f-4dfc-9ad2-80a0a33f998b', answerValue: 'yes', score: 5 }
       ]
    };

    const res = await fetch(`http://localhost:3000/api/patient/questionnaires/${questionnaireVersionId}/submit`, {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    console.log('Submit Response:', JSON.stringify(data, null, 2));

    // verify journey assigned
    const check = await client.query(`SELECT journey_id FROM patient_app_enrollments WHERE id = 'a47125b5-83a4-43c8-962d-6cc972508dcd'`);
    console.log('Assigned Journey:', check.rows[0]);

  } finally {
    client.release();
    pool.end();
  }
}
test();
