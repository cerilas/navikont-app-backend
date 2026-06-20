require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function test() {
  const client = await pool.connect();
  try {
    const user = await client.query(`SELECT * FROM core_users WHERE email = 'deniz@cerilas.com'`);
    const profile = await client.query(`SELECT * FROM patient_profiles WHERE user_id = $1`, [user.rows[0].id]);
    const enrollment = await client.query(`SELECT * FROM patient_app_enrollments WHERE patient_user_id = $1`, [user.rows[0].id]);
    
    console.log("PROFILE:", JSON.stringify(profile.rows[0], null, 2));
    console.log("ENROLLMENT:", JSON.stringify(enrollment.rows[0], null, 2));
  } finally {
    client.release();
    pool.end();
  }
}
test();
