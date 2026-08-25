/**
 * Migrate existing content_module_versions to admin panel-compatible format.
 * 
 * Admin panel expects:
 * - html_content: { html: "...", readTime: N }
 * - video:        { videoUrl: "...", thumbnailUrl: "...", description: "..." }
 * - task:         { taskName: "...", estimatedDuration: N, instructions: "..." }
 * - quiz:         { questions: [{ id, text, type, options, correctOptionIndex, explanation }] }
 */

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const DUMMY_VIDEO_URL = 'https://www.w3schools.com/html/mov_bbb.mp4';
const DUMMY_THUMB_URL = 'https://dummyimage.com/800x450/1a1a2e/fff&text=Video+Gelecek';

function buildHtmlContent(screen) {
  // Build rich HTML from the screen content fields
  let html = '';

  if (screen.key_message) {
    html += `<p class="key-message"><strong>${screen.key_message}</strong></p>\n`;
  }

  if (screen.text) {
    // Convert plain text paragraphs to HTML
    const paragraphs = screen.text.split('\n\n').filter(p => p.trim());
    html += paragraphs.map(p => `<p>${p.trim().replace(/\n/g, '<br>')}</p>`).join('\n');
  }

  if (screen.expanded_text) {
    html += `\n<div class="expanded-content"><p>${screen.expanded_text.replace(/\n/g, '<br>')}</p></div>`;
  }

  if (!html.trim()) {
    html = `<p>${screen.title}</p>`;
  }

  return html;
}

function buildQuizContent(screen) {
  // Parse options if they exist as text
  const optionsText = screen.options || '';
  let parsedOptions = [];

  if (optionsText) {
    // Options are often like "A. ...\nB. ...\nC. ...\nD. ..."
    const lines = optionsText.split('\n').filter(l => l.trim());
    const optionLines = lines.filter(l => l.match(/^[A-Da-d\d][\.\)]/));
    if (optionLines.length > 0) {
      parsedOptions = optionLines.map(l => l.replace(/^[A-Da-d\d][\.\)]\s*/, '').trim());
    } else {
      parsedOptions = lines.map(l => l.trim()).filter(l => l);
    }
  }

  if (parsedOptions.length < 2) {
    parsedOptions = ['Evet', 'Hayır'];
  }

  const question = {
    id: `q_${screen.screen_id || Date.now()}`,
    text: screen.question_text || screen.title || 'Bu konuda ne düşünüyorsunuz?',
    type: 'single_choice',
    options: parsedOptions,
    correctOptionIndex: 0, // default, can be changed in admin
    explanation: screen.correct_feedback || screen.wrong_feedback || ''
  };

  return { questions: [question] };
}

function buildVideoContent(screen) {
  return {
    videoUrl: screen.media || DUMMY_VIDEO_URL,
    thumbnailUrl: DUMMY_THUMB_URL,
    description: screen.text || screen.title || '',
    duration: 0
  };
}

function buildTaskContent(screen) {
  return {
    taskName: screen.title || 'Günlük Görev',
    estimatedDuration: 10,
    instructions: screen.text || screen.title || '',
    completionType: 'manual'
  };
}

async function migrate() {
  const client = await pool.connect();
  try {
    const appId = process.env.NAVIKONT_APP_ID;

    // Get all module versions for this app with their type codes
    const versionsRes = await client.query(`
      SELECT 
        cmv.id as version_id,
        cmv.module_id,
        cmv.title,
        cmv.subtitle,
        cmv.content,
        cmt.code as type_code
      FROM content_module_versions cmv
      JOIN content_modules cm ON cm.id = cmv.module_id
      JOIN content_module_types cmt ON cmt.id = cm.module_type_id
      WHERE cm.app_id = $1
      ORDER BY cm.name
    `, [appId]);

    console.log(`Found ${versionsRes.rows.length} module versions to migrate`);

    let updated = 0;
    let skipped = 0;

    await client.query('BEGIN');

    for (const row of versionsRes.rows) {
      const content = row.content || {};
      const typeCode = row.type_code;

      // Check if it's already in the right format (skip if already migrated)
      const hasScreenId = content.screen_id !== undefined;
      const hasOldScreensArray = Array.isArray(content.screens);

      if (!hasScreenId && !hasOldScreensArray) {
        // Already in admin-compatible format
        skipped++;
        continue;
      }

      // The screen data is either directly in content (screen_id) or in screens array
      const screen = hasScreenId ? content : (content.screens?.[0] || {});

      let newContent;

      if (typeCode === 'video') {
        newContent = buildVideoContent(screen);
      } else if (typeCode === 'quiz') {
        newContent = buildQuizContent(screen);
      } else if (typeCode === 'task') {
        newContent = buildTaskContent(screen);
      } else {
        // html_content (reading, safety, optional, completion, podcast text)
        newContent = {
          html: buildHtmlContent(screen),
          readTime: Math.max(1, Math.ceil((screen.text || '').length / 500))
        };
      }

      // Also store the original structured data so iOS app can still use it
      newContent._navikont = {
        screen_id: screen.screen_id || screen.id,
        type: screen.type,
        cta: screen.cta || 'Devam Et',
        key_message: screen.key_message || '',
        media: screen.media || null,
      };

      await client.query(
        `UPDATE content_module_versions SET content = $1 WHERE id = $2`,
        [JSON.stringify(newContent), row.version_id]
      );

      updated++;
      if (updated % 50 === 0) {
        console.log(`  Migrated ${updated} versions...`);
      }
    }

    await client.query('COMMIT');
    console.log(`\n✅ Migration complete!`);
    console.log(`   Updated: ${updated}`);
    console.log(`   Skipped (already correct format): ${skipped}`);

    // Verify one sample
    const sample = await client.query(`
      SELECT cmv.title, cmv.content, cmt.code
      FROM content_module_versions cmv
      JOIN content_modules cm ON cm.id = cmv.module_id
      JOIN content_module_types cmt ON cmt.id = cm.module_type_id
      WHERE cm.app_id = $1
      LIMIT 1
    `, [appId]);

    if (sample.rows[0]) {
      console.log(`\nSample after migration:`);
      console.log(`  Title: ${sample.rows[0].title}`);
      console.log(`  Type: ${sample.rows[0].code}`);
      console.log(`  Content keys: ${Object.keys(sample.rows[0].content || {}).join(', ')}`);
      if (sample.rows[0].content?.html) {
        console.log(`  HTML preview: ${sample.rows[0].content.html.substring(0, 150)}...`);
      }
    }

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration error:', err.message, err);
  } finally {
    client.release();
    pool.end();
  }
}

migrate();
