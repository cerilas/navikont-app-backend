require('dotenv').config();
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const http = require('http');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const APP_ID = '3ee42ade-0563-4eae-9c37-65b878667446';
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

async function test() {
  const client = await pool.connect();
  try {
    const userRes = await client.query('SELECT id, phone_number FROM patient_users LIMIT 1');
    const user = userRes.rows[0];
    const token = jwt.sign(
      { userId: user.id, phoneNumber: user.phone_number, role: 'patient' },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    
    const options = {
      hostname: 'localhost',
      port: 3000,
      path: '/api/patient/checkins/oab_daily_checkin',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    };
    
    const req = http.request(options, res => {
      console.log(`statusCode: ${res.statusCode}`);
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => { console.log(data); });
    });
    req.end();
  } finally {
    client.release();
    pool.end();
  }
}
test();
