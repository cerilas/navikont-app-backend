const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function fix() {
  const client = await pool.connect();
  try {
    const res = await client.query(`
      SELECT fct.id, fct.name, fctv.id as version_id
      FROM forms_checkin_templates fct
      LEFT JOIN forms_checkin_template_versions fctv ON fctv.checkin_template_id = fct.id
    `);
    console.log(res.rows);
  } finally {
    client.release();
    pool.end();
  }
}
fix();
