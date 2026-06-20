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

    const res = await fetch('http://localhost:3000/api/patient/modules/3f55ef0a-4b89-4802-9911-bb4b7d6accbe/complete', {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    });
    const data = await res.json();
    console.log(res.status, JSON.stringify(data, null, 2));
  } finally {
    client.release();
    pool.end();
  }
}
test();
