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
    if (res.rows.length === 0) return;
    const userId = res.rows[0].id;
    
    await client.query('BEGIN');
    
    // EXACT SAME LOGIC AS server.js
    const birth_date = '1990-01-01';
    const gender = 'male';
    const height_cm = 180.5;
    const weight_kg = 80.5;
    const blood_type = 'A+';
    const disease_ids = [];

    const oldProfileRes = await client.query(
      `SELECT birth_date, gender, height_cm, weight_kg, blood_type FROM patient_profiles WHERE user_id = $1`,
      [userId]
    );
    const oldDiseasesRes = await client.query(
      `SELECT disease_id FROM patient_diseases WHERE patient_user_id = $1`,
      [userId]
    );
    
    let oldData = {};
    if (oldProfileRes.rows.length > 0) {
      oldData = { ...oldProfileRes.rows[0] };
      if (oldData.birth_date) oldData.birth_date = new Date(oldData.birth_date).toISOString().split('T')[0];
    }
    oldData.disease_ids = oldDiseasesRes.rows.map(r => r.disease_id).sort();

    const existing = await client.query(`SELECT id FROM patient_profiles WHERE user_id = $1`, [userId]);

    if (existing.rows.length > 0) {
      await client.query(
        `UPDATE patient_profiles 
         SET birth_date = $1, gender = $2, height_cm = $3, weight_kg = $4, blood_type = $5, updated_at = NOW()
         WHERE user_id = $6`,
        [birth_date, gender, height_cm, weight_kg, blood_type, userId]
      );
    } else {
      await client.query(
        `INSERT INTO patient_profiles (id, user_id, birth_date, gender, height_cm, weight_kg, blood_type, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, NOW(), NOW())`,
        [userId, birth_date, gender, height_cm, weight_kg, blood_type]
      );
    }

    if (Array.isArray(disease_ids)) {
      await client.query(`DELETE FROM patient_diseases WHERE patient_user_id = $1`, [userId]);
      for (const dId of disease_ids) {
        await client.query(`INSERT INTO patient_diseases (patient_user_id, disease_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [userId, dId]);
      }
    }

    const newData = {
      birth_date: birth_date || null,
      gender: gender || null,
      height_cm: height_cm || null,
      weight_kg: weight_kg || null,
      blood_type: blood_type || null,
      disease_ids: Array.isArray(disease_ids) ? [...disease_ids].sort() : []
    };
    
    if (JSON.stringify(oldData) !== JSON.stringify(newData)) {
      await client.query(
        `INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, old_data, new_data, created_at)
         VALUES (gen_random_uuid(), $1, 'update_profile', 'patient', $2, $3, $4, NOW())`,
        [userId, userId, JSON.stringify(oldData), JSON.stringify(newData)]
      );
    }

    await client.query('COMMIT');

    const updated = await client.query(`SELECT * FROM patient_profiles WHERE user_id = $1`, [userId]);
    const diseasesRes2 = await client.query(`SELECT disease_id FROM patient_diseases WHERE patient_user_id = $1`, [userId]);
    let profileData = updated.rows[0];
    if (profileData) {
      profileData.disease_ids = diseasesRes2.rows.map(r => r.disease_id);
    }

    console.log(JSON.stringify({ success: true, profile: profileData }, null, 2));

  } catch (err) {
    console.error("DB Error:", err);
  } finally {
    client.release();
    pool.end();
  }
}
run().catch(console.error);
