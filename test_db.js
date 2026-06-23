const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false
});

async function run() {
  const client = await pool.connect();
  try {
    const res = await client.query("SELECT id FROM core_users WHERE user_type = 'patient' LIMIT 1");
    if (res.rows.length === 0) { console.log("No patient"); return; }
    const realId = res.rows[0].id;
    console.log("Real ID:", realId);

    await client.query('BEGIN');
    
    // Attempt audit log insert directly
    await client.query(
        `INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, old_data, new_data, created_at)
         VALUES (gen_random_uuid(), $1, 'update_profile', 'patient', $2, $3, $4, NOW())`,
        [realId, realId, JSON.stringify({}), JSON.stringify({ height_cm: 180 })]
    );

    await client.query('ROLLBACK');
    console.log("Success with real ID!");
  } catch (err) {
    console.error("DB Error:", err);
    await client.query('ROLLBACK');
  } finally {
    client.release();
    pool.end();
  }
}
run().catch(console.error);
