require('dotenv').config();
const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function seed() {
  const client = await pool.connect();
  try {
    const APP_ID = '3ee42ade-0563-4eae-9c37-65b878667446'; // The default Navikont app id

    // Check if app exists
    const appRes = await client.query('SELECT id FROM content_apps WHERE id = $1', [APP_ID]);
    if (appRes.rows.length === 0) {
      console.log('App not found, cannot seed.');
      return;
    }

    const templateId = crypto.randomUUID();
    const versionId = crypto.randomUUID();

    console.log('Inserting Template...');
    await client.query(`
      INSERT INTO forms_checkin_templates (id, app_id, name, description, frequency, streak_enabled, status)
      VALUES ($1, $2, 'Kapsamlı Günlük Check-in', 'Tüm veri türlerini içeren örnek check-in şablonu.', 'daily', true, 'published')
    `, [templateId, APP_ID]);

    console.log('Inserting Version...');
    await client.query(`
      INSERT INTO forms_checkin_template_versions (id, checkin_template_id, version_number, title, status)
      VALUES ($1, $2, 1, 'Kapsamlı Günlük Check-in', 'published')
    `, [versionId, templateId]);

    const fields = [
      {
        field_type: 'emoji',
        label: 'Bugün ruh haliniz nasıl?',
        is_required: true,
        unit: null
      },
      {
        field_type: 'boolean',
        label: 'İlaçlarınızı aldınız mı?',
        is_required: true,
        unit: null
      },
      {
        field_type: 'number',
        label: 'Bugünkü Kilonuz',
        is_required: false,
        unit: 'kg'
      },
      {
        field_type: 'scale',
        label: 'Günlük stres seviyeniz (1-10)',
        is_required: true,
        unit: null
      },
      {
        field_type: 'text',
        label: 'Eklemek istediğiniz notlar',
        is_required: false,
        unit: null
      }
    ];

    console.log('Inserting Fields...');
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      await client.query(`
        INSERT INTO forms_checkin_fields (id, checkin_template_version_id, field_key, field_type, label, unit, is_required, sort_order)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [
        crypto.randomUUID(),
        versionId,
        `field_seed_${i}`,
        f.field_type,
        f.label,
        f.unit,
        f.is_required,
        i
      ]);
    }

    console.log('Seed completed successfully!');
    console.log('Checkin Template ID:', templateId);
  } catch(e) {
    console.error('Seed Error:', e);
  } finally {
    client.release();
    pool.end();
  }
}

seed();
