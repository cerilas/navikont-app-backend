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
    
    const payload = {
      answers: [
        {
          questionId: "6cc84025-f791-4984-a9ee-5221b710268e",
          answerValue: "opt_0",
          score: 0
        }
      ]
    };

    const res = await fetch('http://localhost:3000/api/patient/questionnaires/52ca64a6-c20f-4069-a5b2-094a8417ed50/submit', {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    console.log(res.status, JSON.stringify(data, null, 2));
  } finally {
    client.release();
    pool.end();
  }
}
test();
