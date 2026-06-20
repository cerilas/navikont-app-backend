// NaviKont Backend API Server
// Single-file Express server with all patient-facing endpoints

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// ─── Configuration ───────────────────────────────────────────────────────────

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const APP_ID = process.env.NAVIKONT_APP_ID;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ─── Middleware ──────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json());

// Prevent all caching for API requests
app.use((req, res, next) => {
  res.header('Cache-Control', 'private, no-cache, no-store, must-revalidate');
  res.header('Expires', '-1');
  res.header('Pragma', 'no-cache');
  next();
});

// JWT Auth Middleware
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ─── Helper Functions ────────────────────────────────────────────────────────

// Get the active enrollment for a patient user
async function getActiveEnrollment(client, userId) {
  const result = await client.query(
    `SELECT * FROM patient_app_enrollments
     WHERE patient_user_id = $1
       AND app_id = $2
       AND status IN ('active', 'activated')
     ORDER BY activated_at DESC NULLS LAST, created_at DESC
     LIMIT 1`,
    [userId, APP_ID]
  );
  return result.rows[0] || null;
}

async function getLatestEnrollment(client, userId) {
  const result = await client.query(
    `SELECT * FROM patient_app_enrollments
     WHERE patient_user_id = $1
       AND app_id = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, APP_ID]
  );
  return result.rows[0] || null;
}

// Get today's date string (YYYY-MM-DD)
function todayStr() {
  return new Date().toISOString().split('T')[0];
}

// ─── AUTH ENDPOINTS ──────────────────────────────────────────────────────────

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'E-posta ve şifre zorunludur' });
  }

  const client = await pool.connect();
  try {
    const userResult = await client.query(
      `SELECT id, email, phone, password_hash, full_name, user_type, status, profile_image
       FROM core_users
       WHERE email = $1 AND deleted_at IS NULL`,
      [email.toLowerCase().trim()]
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'E-posta veya şifre hatalı' });
    }

    const user = userResult.rows[0];

    if (user.status !== 'active') {
      return res.status(403).json({ error: 'Hesabınız aktif değil' });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'E-posta veya şifre hatalı' });
    }

    // Update last_login_at
    await client.query(
      `UPDATE core_users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [user.id]
    );

    // Generate JWT
    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        userType: user.user_type,
      },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    // Get patient profile if exists
    const profileResult = await client.query(
      `SELECT * FROM patient_profiles WHERE user_id = $1`,
      [user.id]
    );

    // Get active enrollment
    const enrollment = await getLatestEnrollment(client, user.id);

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        fullName: user.full_name,
        userType: user.user_type,
        status: user.status,
        profileImage: user.profile_image,
      },
      profile: profileResult.rows[0] || null,
      enrollment: enrollment
        ? {
            id: enrollment.id,
            status: enrollment.status,
            currentDay: enrollment.current_day,
            progressPercent: enrollment.progress_percent,
            startDate: enrollment.start_date,
            endDate: enrollment.end_date,
          }
        : null,
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Sunucu hatası' });
  } finally {
    client.release();
  }
});

// POST /api/auth/change-password
app.post('/api/auth/change-password', authenticate, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: 'Eski ve yeni şifre gereklidir' });
  }

  const client = await pool.connect();
  try {
    const userResult = await client.query(
      `SELECT password_hash FROM core_users WHERE id = $1 AND deleted_at IS NULL`,
      [req.user.userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    }

    const user = userResult.rows[0];
    const validPassword = await bcrypt.compare(oldPassword, user.password_hash);
    
    if (!validPassword) {
      return res.status(401).json({ error: 'Eski şifreniz yanlış' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    
    await client.query(
      `UPDATE core_users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
      [newHash, req.user.userId]
    );

    res.json({ success: true, message: 'Şifreniz başarıyla güncellendi' });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Sunucu hatası' });
  } finally {
    client.release();
  }
});

// ─── PATIENT ENDPOINTS (all require auth) ────────────────────────────────────

// GET /api/patient/me
app.get('/api/patient/me', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    const userResult = await client.query(
      `SELECT id, email, phone, full_name, user_type, status, last_login_at, created_at, profile_image
       FROM core_users
       WHERE id = $1 AND deleted_at IS NULL`,
      [req.user.userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];

    const profileResult = await client.query(
      `SELECT * FROM patient_profiles WHERE user_id = $1`,
      [req.user.userId]
    );

    res.json({
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        fullName: user.full_name,
        userType: user.user_type,
        status: user.status,
        lastLoginAt: user.last_login_at,
        createdAt: user.created_at,
      },
      profile: profileResult.rows[0] || null,
    });
  } catch (err) {
    console.error('Profile error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// POST /api/patient/profile-image
app.post('/api/patient/profile-image', authenticate, async (req, res) => {
  const { profileImage } = req.body;
  if (!profileImage) {
    return res.status(400).json({ error: 'Resim verisi eksik (profileImage)' });
  }

  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE core_users SET profile_image = $1, updated_at = NOW() WHERE id = $2`,
      [profileImage, req.user.userId]
    );

    res.json({ success: true, profileImage });
  } catch (err) {
    console.error('Profile image update error:', err);
    res.status(500).json({ error: 'Sunucu hatası' });
  } finally {
    client.release();
  }
});

// GET /api/patient/notifications
app.get('/api/patient/notifications', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    const notifResult = await client.query(
      `SELECT id, title, body, created_at, read_at, status 
       FROM patient_notifications 
       WHERE user_id = $1 
       ORDER BY created_at DESC LIMIT 50`,
      [req.user.userId]
    );

    res.json(notifResult.rows);
  } catch (err) {
    console.error('Notifications fetch error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// PUT /api/patient/notifications/:id/read
app.put('/api/patient/notifications/:id/read', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE patient_notifications 
       SET read_at = NOW(), status = 'read' 
       WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.userId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Notification read error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// GET /api/patient/enrollment
app.get('/api/patient/enrollment', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    const enrollment = await getActiveEnrollment(client, req.user.userId);
    if (!enrollment) {
      return res.status(404).json({ error: 'No active enrollment found' });
    }

    res.json({ enrollment });
  } catch (err) {
    console.error('Enrollment error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// PUT /api/patient/enrollment/current-day (Test Mode)
app.put('/api/patient/enrollment/current-day', authenticate, async (req, res) => {
  const { currentDay } = req.body;
  if (currentDay === undefined || typeof currentDay !== 'number') {
    return res.status(400).json({ error: 'currentDay is required and must be a number' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get current enrollment to know which day we are completing
    const enrollmentResult = await client.query(
      `SELECT id, current_day FROM patient_app_enrollments 
       WHERE patient_user_id = $1 AND status IN ('active', 'activated')`,
      [req.user.userId]
    );

    if (enrollmentResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No active enrollment found to update' });
    }

    const enrollment = enrollmentResult.rows[0];
    const previousDay = enrollment.current_day || 1;

    // Record the completion of the previous day
    // Wait, what if they advance multiple days? Just record previousDay.
    if (currentDay > previousDay) {
      await client.query(
        `INSERT INTO patient_day_completions (enrollment_id, day_number, completed_at)
         VALUES ($1, $2, NOW())`,
        [enrollment.id, previousDay]
      );
    }

    const result = await client.query(
      `UPDATE patient_app_enrollments 
       SET current_day = $1 
       WHERE id = $2
       RETURNING *`,
      [currentDay, enrollment.id]
    );

    await client.query('COMMIT');
    res.json({ success: true, currentDay: result.rows[0].current_day });
  } catch (err) {
    console.error('Enrollment current-day update error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ─── TODAY'S TASKS HELPER ────────────────────────────────────────────────────

async function getTodayTasks(client, userId, enrollment) {
  const currentDay = enrollment.current_day || 1;

  // Get journey steps for current day
  // content_journey_steps has module_id (FK to content_modules), no step_type/title
  const stepsResult = await client.query(
    `SELECT
       cjs.id AS step_id,
       cjs.journey_id,
       cjs.module_id,
       cjs.day_number,
       cjs.order_in_day,
       cjs.is_required,
       cjs.delay_minutes,
       cjs.time_window_start,
       cjs.time_window_end,
       cm.name AS module_name,
       cmt.code AS module_type,
       cmt.name AS module_type_name,
       cmv.id AS module_version_id,
       cmv.title AS module_title,
       cmv.subtitle AS module_subtitle,
       cmv.content AS module_content,
       cmv.settings AS module_settings
     FROM content_journey_steps cjs
     JOIN content_modules cm ON cm.id = cjs.module_id
     JOIN content_module_types cmt ON cmt.id = cm.module_type_id
     LEFT JOIN LATERAL (
       SELECT id, title, subtitle, content, settings
       FROM content_module_versions
       WHERE module_id = cm.id
       ORDER BY version_number DESC
       LIMIT 1
     ) cmv ON true
     WHERE cjs.journey_id = $1
       AND cjs.day_number = $2
       AND cm.deleted_at IS NULL
     ORDER BY cjs.order_in_day ASC`,
    [enrollment.journey_id, currentDay]
  );

  // Get completion status for each module version
  const tasks = [];
  for (const step of stepsResult.rows) {
    let completionStatus = 'not_started';
    let progressData = null;

    if (step.module_version_id) {
      const progressResult = await client.query(
        `SELECT id, status, started_at, completed_at, progress_percent, result_data
         FROM patient_module_progress
         WHERE enrollment_id = $1
           AND patient_user_id = $2
           AND module_version_id = $3
           AND app_id = $4
           AND day_number = $5
         ORDER BY created_at DESC
         LIMIT 1`,
        [enrollment.id, userId, step.module_version_id, APP_ID, currentDay]
      );

      if (progressResult.rows.length > 0) {
        progressData = progressResult.rows[0];
        completionStatus = progressData.status;
      }
    }

    // Inject riskStatus if the module is a risk alert
    if (step.module_type === 'risk' || step.module_type === 'risk_alert') {
      let riskStatus = 'missing';
      let moduleContentObj = step.module_content || {};
      
      // Parse if string
      if (typeof moduleContentObj === 'string') {
        try {
          moduleContentObj = JSON.parse(moduleContentObj);
        } catch (e) {
          moduleContentObj = {};
        }
      }

      if (moduleContentObj.targetSurvey) {
        const targetModuleId = moduleContentObj.targetSurvey;
        const threshold = parseInt(moduleContentObj.threshold) || 0;
        
        // Get target form id from the target module's latest version
        const targetModuleResult = await client.query(
          `SELECT content FROM content_module_versions WHERE module_id = $1 ORDER BY version_number DESC LIMIT 1`,
          [targetModuleId]
        );
        if (targetModuleResult.rows.length > 0) {
           let tc = targetModuleResult.rows[0].content || {};
           if (typeof tc === 'string') {
              try { tc = JSON.parse(tc); } catch(e) {}
           }
           moduleContentObj.computedTargetFormId = tc.formId || null;
        }

        if (moduleContentObj.computedTargetFormId) {
          const qRes = await client.query(
            `SELECT total_score 
             FROM patient_questionnaire_responses pqr
             JOIN forms_questionnaire_versions fqv ON fqv.id = pqr.questionnaire_version_id
             JOIN patient_app_enrollments pae ON pae.id = pqr.enrollment_id
             WHERE (fqv.questionnaire_id = $1 OR fqv.id = $1)
               AND pae.patient_user_id = $2
               AND DATE(pqr.submitted_at) = CURRENT_DATE
             ORDER BY pqr.submitted_at DESC LIMIT 1`,
            [moduleContentObj.computedTargetFormId, userId]
          );

          if (qRes.rows.length > 0) {
            const score = parseInt(qRes.rows[0].total_score) || 0;
            if (score >= threshold) {
              riskStatus = 'risk';
            } else {
              riskStatus = 'safe';
            }
          }
        }

        // Fallback to module progress if not resolved yet
        if (riskStatus === 'missing') {
          const surveyResult = await client.query(
            `SELECT result_data 
             FROM patient_module_progress pmp
             JOIN content_module_versions cmv ON cmv.id = pmp.module_version_id
             WHERE cmv.module_id = $1
               AND pmp.patient_user_id = $2
               AND pmp.status = 'completed'
             ORDER BY pmp.created_at DESC
             LIMIT 1`,
            [targetModuleId, userId]
          );
          
          if (surveyResult.rows.length > 0) {
            let resData = surveyResult.rows[0].result_data || {};
            if (typeof resData === 'string') {
               try { resData = JSON.parse(resData); } catch(e) {}
            }
            const score = parseInt(resData.total_score || resData.score) || 0;
            
            if (score >= threshold) {
              riskStatus = 'risk';
            } else {
              riskStatus = 'safe';
            }
          }
        }
      }
      
      moduleContentObj.computedRiskStatus = riskStatus;
      step.module_content = moduleContentObj; // Reassign back
    }

    tasks.push({
      stepId: step.step_id,
      dayNumber: step.day_number,
      orderInDay: step.order_in_day,
      isRequired: step.is_required,
      delayMinutes: step.delay_minutes,
      timeWindowStart: step.time_window_start,
      timeWindowEnd: step.time_window_end,
      moduleId: step.module_id,
      moduleVersionId: step.module_version_id,
      moduleName: step.module_name,
      moduleType: step.module_type,
      moduleTypeName: step.module_type_name,
      moduleTitle: step.module_title,
      moduleSubtitle: step.module_subtitle,
      moduleContent: step.module_content,
      moduleSettings: step.module_settings,
      completionStatus,
      progress: progressData,
    });
  }

  return tasks;
}

// GET /api/patient/today
app.get('/api/patient/today', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    const enrollment = await getActiveEnrollment(client, req.user.userId);
    if (!enrollment) {
      return res.status(404).json({ error: 'No active enrollment found' });
    }

    const tasks = await getTodayTasks(client, req.user.userId, enrollment);

    const totalTasks = tasks.length;
    const completedTasks = tasks.filter((t) => t.completionStatus === 'completed').length;

    res.json({
      currentDay: enrollment.current_day || 1,
      totalTasks,
      completedTasks,
      tasks,
    });
  } catch (err) {
    console.error('Today error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// GET /api/patient/dashboard/calendar
app.get('/api/patient/dashboard/calendar', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    const enrollment = await getLatestEnrollment(client, req.user.userId);
    if (!enrollment) {
      return res.status(404).json({ error: 'No active enrollment found' });
    }

    const currentDay = enrollment.current_day || 1;
    const startDate = enrollment.activated_at || enrollment.created_at || new Date();

    // 1. Get total days for this program from content_journey_steps
    const journeyResult = await client.query(
      `SELECT MAX(day_number) as max_day 
       FROM content_journey_steps 
       WHERE journey_id = $1`,
      [enrollment.journey_id]
    );
    const totalDays = journeyResult.rows[0]?.max_day || 0;

    if (totalDays === 0) {
      return res.json({ enrollmentDate: startDate, currentDay, totalDays: 0, days: [] });
    }

    // 2. Fetch completions
    let completions = [];
    try {
      const compRes = await client.query(
        `SELECT day_number, completed_at FROM patient_day_completions WHERE enrollment_id = $1 ORDER BY day_number ASC`,
        [enrollment.id]
      );
      completions = compRes.rows;
    } catch (e) {
      console.error('No patient_day_completions table or error:', e);
    }

    if (completions.length === 0 && currentDay > 1) {
      // Fake completions for backwards compatibility
      const fakeCompletions = await client.query(
        `SELECT day_number, MAX(completed_at) as completed_at FROM patient_module_progress
         WHERE enrollment_id = $1 AND status = 'completed'
         GROUP BY day_number ORDER BY day_number ASC`,
        [enrollment.id]
      );
      completions = fakeCompletions.rows;
    }

    // 3. Generate dates dynamically
    const days = [];
    const baseDate = new Date(startDate);
    baseDate.setUTCHours(0,0,0,0);
    
    const today = new Date();
    today.setUTCHours(0,0,0,0);

    let iterDate = new Date(baseDate);

    // If enrollment is in the future (shouldn't happen, but just in case)
    if (iterDate > today) {
       iterDate = new Date(today);
    }

    while (iterDate <= today) {
      const iterDateStr = iterDate.toISOString().split('T')[0];
      
      let compsBefore = 0;
      let completedOnThisDate = false;
      let maxDayCompletedOnThisDate = null;

      for (const comp of completions) {
        if (!comp.completed_at) continue;
        const compDateStr = comp.completed_at.toISOString().split('T')[0];
        if (compDateStr < iterDateStr) {
          compsBefore++;
        } else if (compDateStr === iterDateStr) {
          completedOnThisDate = true;
          maxDayCompletedOnThisDate = comp.day_number;
        }
      }

      let programDay = 1 + compsBefore;
      let status = 'missed';

      if (iterDate.getTime() === today.getTime()) {
        status = completedOnThisDate ? 'completed' : 'current';
      } else {
        status = completedOnThisDate ? 'completed' : 'missed';
      }

      if (completedOnThisDate && maxDayCompletedOnThisDate && maxDayCompletedOnThisDate > programDay) {
        programDay = maxDayCompletedOnThisDate;
      }

      days.push({
        dayNumber: programDay,
        date: iterDate.toISOString(),
        status
      });

      iterDate.setUTCDate(iterDate.getUTCDate() + 1);
    }

    // Generate projected future dates up to totalDays
    if (days.length > 0) {
      const lastPushedDay = days[days.length - 1].dayNumber;
      let startFutureDay = lastPushedDay + 1;
      let futureIter = new Date(today);
      futureIter.setUTCDate(futureIter.getUTCDate() + 1);

      for (let i = startFutureDay; i <= totalDays; i++) {
        days.push({
          dayNumber: i,
          date: futureIter.toISOString(),
          status: 'future'
        });
        futureIter.setUTCDate(futureIter.getUTCDate() + 1);
      }
    }

    res.json({
      enrollmentDate: startDate,
      currentDay,
      totalDays,
      days
    });
  } catch (err) {
    console.error('Calendar error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});
// ─── DEVICES ─────────────────────────────────────────────────────────────────
app.post('/api/patient/device-token', authenticate, async (req, res) => {
  const { deviceToken, platform = 'ios', appVersion } = req.body;
  if (!deviceToken) {
    return res.status(400).json({ error: 'Device token is required' });
  }

  try {
    await pool.query(
      `INSERT INTO patient_devices (patient_user_id, device_token, platform, app_version, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (patient_user_id, device_token) 
       DO UPDATE SET updated_at = NOW(), platform = EXCLUDED.platform, app_version = EXCLUDED.app_version`,
      [req.user.userId, deviceToken, platform, appVersion || null]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Error saving device token:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── DASHBOARD ───────────────────────────────────────────────────────────────

// GET /api/patient/dashboard
app.get('/api/patient/dashboard', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    const enrollment = await getLatestEnrollment(client, req.user.userId);
    if (!enrollment) {
      return res.status(404).json({ error: 'No active enrollment found' });
    }

    if (enrollment.status === 'paused' || enrollment.status === 'cancelled') {
      return res.json({
        enrollment: {
          id: enrollment.id,
          status: enrollment.status,
          currentDay: enrollment.current_day,
          progressPercent: enrollment.progress_percent,
          startDate: enrollment.start_date,
          endDate: enrollment.end_date,
          activatedAt: enrollment.activated_at,
        },
        today: null,
        tasks: [],
        streak: { currentStreak: 0, longestStreak: 0 },
        progressPercent: enrollment.progress_percent || 0,
        totalSteps: 1,
        completedModules: 0,
        moduleProgress: []
      });
    }

    // Today's tasks
    const tasks = await getTodayTasks(client, req.user.userId, enrollment);
    const totalTasks = tasks.length;
    const completedTasks = tasks.filter((t) => t.completionStatus === 'completed').length;

    // Streak info
    const streakResult = await client.query(
      `SELECT * FROM patient_streaks
       WHERE patient_user_id = $1
         AND enrollment_id = $2
         AND app_id = $3
         AND streak_type = 'daily_tasks'
       ORDER BY updated_at DESC
       LIMIT 1`,
      [req.user.userId, enrollment.id, APP_ID]
    );

    // Overall progress: count completed modules vs total journey steps
    const totalStepsResult = await client.query(
      `SELECT COUNT(*) AS total FROM content_journey_steps WHERE journey_id = $1`,
      [enrollment.journey_id]
    );

    const completedModulesResult = await client.query(
      `SELECT COUNT(*) AS completed FROM patient_module_progress
       WHERE enrollment_id = $1
         AND patient_user_id = $2
         AND app_id = $3
         AND status = 'completed'`,
      [enrollment.id, req.user.userId, APP_ID]
    );

    const totalSteps = parseInt(totalStepsResult.rows[0].total) || 1;
    const completedModules = parseInt(completedModulesResult.rows[0].completed) || 0;

    // Recent notifications (unread)
    const notifResult = await client.query(
      `SELECT id, title, body, status, scheduled_at, sent_at, read_at, created_at
       FROM patient_notifications
       WHERE user_id = $1
         AND app_id = $2
         AND status != 'cancelled'
       ORDER BY created_at DESC
       LIMIT 5`,
      [req.user.userId, APP_ID]
    );

    let streakData = streakResult.rows[0] || {
      current_streak: 0,
      longest_streak: 0,
      last_completed_date: null,
      freeze_count: 0,
    };
    
    if (streakData.current_streak > (enrollment.current_day || 1)) {
      streakData.current_streak = enrollment.current_day || 1;
    }

    res.json({
      enrollment: {
        id: enrollment.id,
        status: enrollment.status,
        currentDay: enrollment.current_day,
        progressPercent: enrollment.progress_percent,
        startDate: enrollment.start_date,
        endDate: enrollment.end_date,
        activatedAt: enrollment.activated_at,
      },
      today: {
        currentDay: enrollment.current_day || 1,
        totalTasks,
        completedTasks,
        tasks,
      },
      progress: {
        totalSteps,
        completedModules,
        progressPercent: Math.round((completedModules / totalSteps) * 100),
      },
      streak: streakData,
      notifications: notifResult.rows,
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ─── MODULE DETAIL & COMPLETION ──────────────────────────────────────────────

// GET /api/patient/modules/:moduleVersionId
app.get('/api/patient/modules/:moduleVersionId', authenticate, async (req, res) => {
  const { moduleVersionId } = req.params;
  const client = await pool.connect();
  try {
    const enrollment = await getActiveEnrollment(client, req.user.userId);
    if (!enrollment) {
      return res.status(404).json({ error: 'No active enrollment found' });
    }

    const moduleResult = await client.query(
      `SELECT cmv.id, cmv.module_id, cmv.title, cmv.subtitle, cmv.content, cmv.settings,
              cmv.version_number,
              cm.name AS module_name,
              cmt.code AS module_type,
              cmt.name AS module_type_name
       FROM content_module_versions cmv
       JOIN content_modules cm ON cm.id = cmv.module_id
       JOIN content_module_types cmt ON cmt.id = cm.module_type_id
       WHERE cmv.id = $1
         AND cm.app_id = $2
         AND cm.deleted_at IS NULL`,
      [moduleVersionId, APP_ID]
    );

    if (moduleResult.rows.length === 0) {
      return res.status(404).json({ error: 'Module not found' });
    }

    const mod = moduleResult.rows[0];

    // Get progress for this module
    const progressResult = await client.query(
      `SELECT id, status, started_at, completed_at, progress_percent, result_data
       FROM patient_module_progress
       WHERE enrollment_id = $1
         AND patient_user_id = $2
         AND module_version_id = $3
         AND app_id = $4
       ORDER BY created_at DESC
       LIMIT 1`,
      [enrollment.id, req.user.userId, moduleVersionId, APP_ID]
    );

    res.json({
      module: {
        id: mod.id,
        moduleId: mod.module_id,
        title: mod.title,
        subtitle: mod.subtitle,
        content: mod.content,
        settings: mod.settings,
        versionNumber: mod.version_number,
        moduleName: mod.module_name,
        moduleType: mod.module_type,
        moduleTypeName: mod.module_type_name,
      },
      progress: progressResult.rows[0] || null,
    });
  } catch (err) {
    console.error('Module detail error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// POST /api/patient/modules/:moduleVersionId/complete
app.post('/api/patient/modules/:moduleVersionId/complete', authenticate, async (req, res) => {
  const { moduleVersionId } = req.params;
  const { resultData } = req.body; // optional result data from the client
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const enrollment = await getActiveEnrollment(client, req.user.userId);
    if (!enrollment) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No active enrollment found' });
    }

    // Check module exists
    const moduleCheck = await client.query(
      `SELECT cmv.id, cmv.content, cmt.code AS module_type FROM content_module_versions cmv
       JOIN content_modules cm ON cm.id = cmv.module_id
       JOIN content_module_types cmt ON cmt.id = cm.module_type_id
       WHERE cmv.id = $1 AND cm.app_id = $2 AND cm.deleted_at IS NULL`,
      [moduleVersionId, APP_ID]
    );

    if (moduleCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Module not found' });
    }

    let finalResultData = resultData || {};
    const moduleType = moduleCheck.rows[0].module_type;
    const moduleContent = moduleCheck.rows[0].content;

    if (moduleType === 'risk' || moduleType === 'risk_alert') {
      let moduleContentObj = moduleContent || {};
      if (typeof moduleContentObj === 'string') {
        try { moduleContentObj = JSON.parse(moduleContentObj); } catch(e) { moduleContentObj = {}; }
      }

      if (moduleContentObj.targetSurvey) {
        const targetModuleId = moduleContentObj.targetSurvey;
        const threshold = parseInt(moduleContentObj.threshold) || 0;
        let riskStatus = 'missing';
        let foundScore = null;

        const targetModuleResult = await client.query(
          `SELECT content FROM content_module_versions WHERE module_id = $1 ORDER BY version_number DESC LIMIT 1`,
          [targetModuleId]
        );
        let computedTargetFormId = null;
        if (targetModuleResult.rows.length > 0) {
           let tc = targetModuleResult.rows[0].content || {};
           if (typeof tc === 'string') {
              try { tc = JSON.parse(tc); } catch(e) {}
           }
           computedTargetFormId = tc.formId || null;
        }

        if (computedTargetFormId) {
          const qRes = await client.query(
            `SELECT total_score 
             FROM patient_questionnaire_responses pqr
             JOIN forms_questionnaire_versions fqv ON fqv.id = pqr.questionnaire_version_id
             JOIN patient_app_enrollments pae ON pae.id = pqr.enrollment_id
             WHERE (fqv.questionnaire_id = $1 OR fqv.id = $1)
               AND pae.patient_user_id = $2
               AND DATE(pqr.submitted_at) = CURRENT_DATE
             ORDER BY pqr.submitted_at DESC LIMIT 1`,
            [computedTargetFormId, req.user.userId]
          );

          if (qRes.rows.length > 0) {
            foundScore = parseInt(qRes.rows[0].total_score) || 0;
            if (foundScore >= threshold) {
              riskStatus = 'risk';
            } else {
              riskStatus = 'safe';
            }
          }
        }

        if (riskStatus === 'missing') {
          const surveyResult = await client.query(
            `SELECT result_data 
             FROM patient_module_progress pmp
             JOIN content_module_versions cmv ON cmv.id = pmp.module_version_id
             WHERE cmv.module_id = $1
               AND pmp.patient_user_id = $2
               AND pmp.status = 'completed'
             ORDER BY pmp.created_at DESC LIMIT 1`,
            [targetModuleId, req.user.userId]
          );
          if (surveyResult.rows.length > 0) {
            let resData = surveyResult.rows[0].result_data || {};
            if (typeof resData === 'string') {
               try { resData = JSON.parse(resData); } catch(e) {}
            }
            foundScore = parseInt(resData.total_score || resData.score) || 0;
            if (foundScore >= threshold) {
              riskStatus = 'risk';
            } else {
              riskStatus = 'safe';
            }
          }
        }

        finalResultData = {
          ...finalResultData,
          score: foundScore,
          threshold: threshold,
          riskStatus: riskStatus
        };
      }
    }

    // Upsert patient_module_progress
    const existingProgress = await client.query(
      `SELECT id FROM patient_module_progress
       WHERE enrollment_id = $1
         AND patient_user_id = $2
         AND module_version_id = $3
         AND app_id = $4
         AND day_number = $5`,
      [enrollment.id, req.user.userId, moduleVersionId, APP_ID, enrollment.current_day || 1]
    );

    let progressRecord;
    if (existingProgress.rows.length > 0) {
      progressRecord = await client.query(
        `UPDATE patient_module_progress
         SET status = 'completed',
             completed_at = NOW(),
             progress_percent = 100,
             result_data = $1,
             updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [Object.keys(finalResultData).length > 0 ? JSON.stringify(finalResultData) : null, existingProgress.rows[0].id]
      );
    } else {
      progressRecord = await client.query(
        `INSERT INTO patient_module_progress
           (id, enrollment_id, patient_user_id, app_id, app_version_id, module_version_id,
            status, started_at, completed_at, progress_percent, result_data, created_at, updated_at, day_number)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'completed', NOW(), NOW(), 100, $6, NOW(), NOW(), $7)
         RETURNING *`,
        [
          enrollment.id,
          req.user.userId,
          APP_ID,
          enrollment.app_version_id,
          moduleVersionId,
          Object.keys(finalResultData).length > 0 ? JSON.stringify(finalResultData) : null,
          enrollment.current_day || 1
        ]
      );
    }

    // Recalculate enrollment progress_percent
    const totalStepsResult = await client.query(
      `SELECT COUNT(*) AS total FROM content_journey_steps WHERE journey_id = $1`,
      [enrollment.journey_id]
    );
    const completedResult = await client.query(
      `SELECT COUNT(*) AS completed FROM patient_module_progress
       WHERE enrollment_id = $1 AND patient_user_id = $2 AND app_id = $3 AND status = 'completed'`,
      [enrollment.id, req.user.userId, APP_ID]
    );

    const total = parseInt(totalStepsResult.rows[0].total) || 1;
    const completed = parseInt(completedResult.rows[0].completed) || 0;
    const newProgressPercent = Math.round((completed / total) * 100);

    await client.query(
      `UPDATE patient_app_enrollments
       SET progress_percent = $1, updated_at = NOW()
       WHERE id = $2`,
      [newProgressPercent, enrollment.id]
    );

    // Evaluate Daily Tasks Streak
    const todayTasks = await getTodayTasks(client, req.user.userId, enrollment);
    const allCompleted = todayTasks.length > 0 && todayTasks.every(t => t.completionStatus === 'completed');

    if (allCompleted) {
      const today = new Date().toISOString().split('T')[0];
      const dailyStreakResult = await client.query(
        `SELECT * FROM patient_streaks
         WHERE patient_user_id = $1 AND enrollment_id = $2 AND app_id = $3 AND streak_type = 'daily_tasks'
         LIMIT 1`,
        [req.user.userId, enrollment.id, APP_ID]
      );

      if (dailyStreakResult.rows.length > 0) {
        const streak = dailyStreakResult.rows[0];
        const lastDateStr = streak.last_completed_date ? streak.last_completed_date.toISOString().split('T')[0] : null;

        if (lastDateStr !== today) {
          const yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          const yesterdayStr = yesterday.toISOString().split('T')[0];

          let currentStreak = streak.current_streak || 0;
          if (lastDateStr === yesterdayStr) {
            currentStreak += 1;
          } else {
            currentStreak = 1;
          }

          let longestStreak = Math.max(streak.longest_streak || 0, currentStreak);

          await client.query(
            `UPDATE patient_streaks
             SET current_streak = $1, longest_streak = $2, last_completed_date = $3, updated_at = NOW()
             WHERE id = $4`,
            [currentStreak, longestStreak, today, streak.id]
          );
        }
      } else {
        await client.query(
          `INSERT INTO patient_streaks
             (id, patient_user_id, enrollment_id, app_id, app_version_id,
              streak_type, current_streak, longest_streak, last_completed_date, freeze_count, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, 'daily_tasks', 1, 1, $5, 0, NOW())`,
          [req.user.userId, enrollment.id, APP_ID, enrollment.app_version_id, today]
        );
      }
    }

    await client.query('COMMIT');

    res.json({
      success: true,
      progress: progressRecord.rows[0],
      enrollmentProgress: {
        totalSteps: total,
        completedModules: completed,
        progressPercent: newProgressPercent,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Module complete error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ─── QUESTIONNAIRE ENDPOINTS ─────────────────────────────────────────────────

// GET /api/patient/questionnaires/:questionnaireVersionId
app.get('/api/patient/questionnaires/:questionnaireVersionId', authenticate, async (req, res) => {
  const { questionnaireVersionId } = req.params;
  const client = await pool.connect();
  try {
    // Get questionnaire version
    const qvResult = await client.query(
      `SELECT fqv.id, fqv.questionnaire_id, fqv.title, fqv.description_html,
              fqv.version_number, fqv.scoring_method, fqv.risk_rules, fqv.status,
              fq.name AS questionnaire_name
       FROM forms_questionnaire_versions fqv
       JOIN forms_questionnaires fq ON fq.id = fqv.questionnaire_id
       WHERE (fqv.id = $1 OR fqv.questionnaire_id = $1)
         AND fq.app_id = $2
         AND fqv.status = 'published'
       ORDER BY fqv.version_number DESC
       LIMIT 1`,
      [questionnaireVersionId, APP_ID]
    );

    if (qvResult.rows.length === 0) {
      return res.status(404).json({ error: 'Questionnaire not found' });
    }

    const questionnaire = qvResult.rows[0];

    // Get questions using the resolved questionnaire version id
    const questionsResult = await client.query(
      `SELECT id, question_key, question_type, label, description_html, placeholder, is_required, sort_order,
              validation_rules, display_rules, metadata
       FROM forms_questions
       WHERE questionnaire_version_id = $1
       ORDER BY sort_order ASC`,
      [questionnaire.id]
    );

    // Get options for each question
    const questions = [];
    for (const q of questionsResult.rows) {
      const optionsResult = await client.query(
        `SELECT id, question_id, option_label, option_value, score, sort_order
         FROM forms_question_options
         WHERE question_id = $1
         ORDER BY sort_order ASC`,
        [q.id]
      );

      questions.push({
        id: q.id,
        questionKey: q.question_key,
        questionType: q.question_type,
        label: q.label,
        descriptionHtml: q.description_html,
        placeholder: q.placeholder,
        isRequired: q.is_required,
        sortOrder: q.sort_order,
        validationRules: q.validation_rules,
        displayRules: q.display_rules,
        metadata: q.metadata,
        options: optionsResult.rows.map(o => ({
          id: o.id,
          questionId: o.question_id,
          label: o.option_label,
          value: o.option_value,
          score: o.score,
          sortOrder: o.sort_order
        }))
      });
    }

    // Check if already submitted
    const enrollment = await getActiveEnrollment(client, req.user.userId);
    let previousResponse = null;
    if (enrollment) {
      const respResult = await client.query(
        `SELECT id, status, total_score, risk_level, submitted_at
         FROM patient_questionnaire_responses
         WHERE enrollment_id = $1
           AND patient_user_id = $2
           AND questionnaire_version_id = $3
           AND app_id = $4
         ORDER BY submitted_at DESC
         LIMIT 1`,
        [enrollment.id, req.user.userId, questionnaireVersionId, APP_ID]
      );
      if (respResult.rows.length > 0) {
        previousResponse = respResult.rows[0];
      }
    }

    res.json({
      questionnaire: {
        id: questionnaire.id,
        questionnaireId: questionnaire.questionnaire_id,
        title: questionnaire.title,
        descriptionHtml: questionnaire.description_html,
        versionNumber: questionnaire.version_number,
        scoringMethod: questionnaire.scoring_method,
        riskRules: questionnaire.risk_rules,
        questionnaireName: questionnaire.questionnaire_name,
      },
      questions,
      previousResponse,
    });
  } catch (err) {
    console.error('Questionnaire error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// POST /api/patient/questionnaires/:questionnaireVersionId/submit
app.post('/api/patient/questionnaires/:questionnaireVersionId/submit', authenticate, async (req, res) => {
  const { questionnaireVersionId } = req.params;
  const { answers } = req.body; // array of { questionId, answerValue, score? }

  if (!answers || !Array.isArray(answers)) {
    return res.status(400).json({ error: 'Answers array is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const enrollment = await getActiveEnrollment(client, req.user.userId);
    if (!enrollment) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No active enrollment found' });
    }

    // Calculate total score
    let totalScore = 0;
    for (const answer of answers) {
      if (answer.score !== undefined && answer.score !== null) {
        totalScore += answer.score;
      }
    }

    // Determine risk level from questionnaire risk_rules
    const qvResult = await client.query(
      `SELECT id, scoring_method, risk_rules FROM forms_questionnaire_versions 
       WHERE (id = $1 OR questionnaire_id = $1)
         AND status = 'published'
       ORDER BY version_number DESC LIMIT 1`,
      [questionnaireVersionId]
    );

    let resolvedVersionId = questionnaireVersionId;
    let riskLevel = 'low';
    if (qvResult.rows.length > 0) {
      resolvedVersionId = qvResult.rows[0].id;
      if (qvResult.rows[0].risk_rules) {
      const rules = qvResult.rows[0].risk_rules;
      if (Array.isArray(rules)) {
        // rules expected as [{ min, max, level }]
        for (const rule of rules) {
          if (totalScore >= (rule.min || 0) && totalScore <= (rule.max || Infinity)) {
            riskLevel = rule.level || rule.risk_level || 'low';
            break;
          }
        }
      } else if (typeof rules === 'object') {
        // Could be { low: { min, max }, medium: { min, max }, high: { min, max } }
        for (const [level, range] of Object.entries(rules)) {
          if (totalScore >= (range.min || 0) && totalScore <= (range.max || Infinity)) {
            riskLevel = level;
            break;
          }
        }
      }
      }
    }

    // Check if there is already a response today
    const today = new Date().toISOString().split('T')[0];
    const existingResp = await client.query(
      `SELECT id FROM patient_questionnaire_responses
       WHERE enrollment_id = $1 AND patient_user_id = $2 AND questionnaire_version_id = $3
         AND DATE(submitted_at AT TIME ZONE 'UTC') = $4
       LIMIT 1`,
      [enrollment.id, req.user.userId, resolvedVersionId, today]
    );

    let responseId;
    let submittedAt;

    if (existingResp.rows.length > 0) {
      responseId = existingResp.rows[0].id;
      const updateResult = await client.query(
        `UPDATE patient_questionnaire_responses
         SET total_score = $1, risk_level = $2, submitted_at = NOW(), metadata = $3
         WHERE id = $4
         RETURNING *`,
        [totalScore, riskLevel, JSON.stringify({ answeredAt: new Date().toISOString() }), responseId]
      );
      submittedAt = updateResult.rows[0].submitted_at;
      // Delete old answers so we can insert new ones
      await client.query(`DELETE FROM patient_questionnaire_answers WHERE response_id = $1`, [responseId]);
    } else {
      const responseResult = await client.query(
        `INSERT INTO patient_questionnaire_responses
           (id, enrollment_id, patient_user_id, app_id, app_version_id,
            questionnaire_version_id, status, total_score, risk_level, submitted_at, metadata)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'completed', $6, $7, NOW(), $8)
         RETURNING *`,
        [
          enrollment.id,
          req.user.userId,
          APP_ID,
          enrollment.app_version_id,
          resolvedVersionId,
          totalScore,
          riskLevel,
          JSON.stringify({ answeredAt: new Date().toISOString() }),
        ]
      );
      responseId = responseResult.rows[0].id;
      submittedAt = responseResult.rows[0].submitted_at;
    }

    // Insert individual answers
    for (const answer of answers) {
      await client.query(
        `INSERT INTO patient_questionnaire_answers
           (id, response_id, question_id, answer_value, score, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, NOW())`,
        [
          responseId,
          answer.questionId,
          JSON.stringify(answer.answerValue),
          answer.score || 0,
        ]
      );
    }

    // Create risk alert if high risk
    if (riskLevel === 'high' || riskLevel === 'critical') {
      await client.query(
        `INSERT INTO patient_risk_alerts
           (patient_user_id, doctor_user_id, enrollment_id, app_id, app_version_id,
            source_type, source_id, severity, title, message, status, triggered_at, metadata)
         VALUES ($1, $2, $3, $4, $5, 'questionnaire', $6, $7, $8, $9, 'new', NOW(), $10)`,
        [
          req.user.userId,
          enrollment.doctor_user_id,
          enrollment.id,
          APP_ID,
          enrollment.app_version_id,
          responseId,
          riskLevel,
          'High Risk Questionnaire Response',
          `Patient scored ${totalScore} on questionnaire (risk level: ${riskLevel})`,
          JSON.stringify({ totalScore, riskLevel, questionnaireVersionId }),
        ]
      );
    }

    await client.query('COMMIT');

    res.json({
      success: true,
      response: {
        id: responseId,
        totalScore,
        riskLevel,
        submittedAt,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Questionnaire submit error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ─── CHECK-IN ENDPOINTS ─────────────────────────────────────────────────────

// GET /api/patient/checkins/:checkinTemplateVersionId
app.get('/api/patient/checkins/:checkinTemplateVersionId', authenticate, async (req, res) => {
  const { checkinTemplateVersionId } = req.params;
  const client = await pool.connect();
  try {
    let resolvedParamId = checkinTemplateVersionId;
    let isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(resolvedParamId);

    if (isUUID) {
      // It might be a content_modules ID. Let's try to resolve it.
      const moduleRes = await client.query(`SELECT content FROM content_module_versions WHERE module_id = $1 ORDER BY version_number DESC LIMIT 1`, [resolvedParamId]);
      if (moduleRes.rows.length > 0 && moduleRes.rows[0].content && moduleRes.rows[0].content.checkinTemplateId) {
        resolvedParamId = moduleRes.rows[0].content.checkinTemplateId;
        isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(resolvedParamId);
      }
    }

    // Get checkin template version
    const ctvResult = await client.query(
      `SELECT fctv.id, fctv.checkin_template_id, fctv.title, fct.description,
              fctv.version_number, fctv.status, fct.settings,
              fct.name AS template_name
       FROM forms_checkin_template_versions fctv
       JOIN forms_checkin_templates fct ON fct.id = fctv.checkin_template_id
       WHERE (fctv.id::text = $1 OR fct.id::text = $1)
         AND fct.app_id = $2
       ORDER BY fctv.version_number DESC LIMIT 1`,
      [isUUID ? resolvedParamId : '00000000-0000-0000-0000-000000000000', APP_ID]
    );
    
    // Fallback if not UUID
    if (!isUUID && ctvResult.rows.length === 0) {
      const ctvFallbackResult = await client.query(
        `SELECT fctv.id, fctv.checkin_template_id, fctv.title, fct.description,
                fctv.version_number, fctv.status, fct.settings,
                fct.name AS template_name
         FROM forms_checkin_template_versions fctv
         JOIN forms_checkin_templates fct ON fct.id = fctv.checkin_template_id
         WHERE fct.name = $1
           AND fct.app_id = $2
         ORDER BY fctv.version_number DESC LIMIT 1`,
        [resolvedParamId, APP_ID]
      );
      if (ctvFallbackResult.rows.length > 0) {
        ctvResult.rows.push(ctvFallbackResult.rows[0]);
      }
    }

    if (ctvResult.rows.length === 0) {
      return res.status(404).json({ error: 'Check-in template not found' });
    }

    const template = ctvResult.rows[0];
    const resolvedVersionId = template.id;

    // Get fields
    const fieldsResult = await client.query(
      `SELECT id, field_key, label, field_type, is_required, sort_order,
              validation_rules
       FROM forms_checkin_fields
       WHERE checkin_template_version_id = $1
       ORDER BY sort_order ASC`,
      [resolvedVersionId]
    );

    // Check if already submitted today
    const enrollment = await getActiveEnrollment(client, req.user.userId);
    let todaySubmission = null;
    if (enrollment) {
      const subResult = await client.query(
        `SELECT id, checkin_date, submitted_at, streak_day, risk_level
         FROM patient_checkin_submissions
         WHERE enrollment_id = $1
           AND patient_user_id = $2
           AND checkin_template_version_id = $3
           AND app_id = $4
           AND checkin_date = $5
         LIMIT 1`,
        [enrollment.id, req.user.userId, resolvedVersionId, APP_ID, todayStr()]
      );
      if (subResult.rows.length > 0) {
        todaySubmission = subResult.rows[0];
      }
    }

    res.json({
      id: template.id,
      checkinTemplateId: template.checkin_template_id,
      title: template.title,
      description: template.description,
      versionNumber: template.version_number,
      settings: template.settings,
      templateName: template.template_name,
      fields: fieldsResult.rows.map((f) => ({
        id: f.id,
        fieldKey: f.field_key,
        label: f.label,
        fieldType: f.field_type,
        isRequired: f.is_required,
        sortOrder: f.sort_order,
        validationRules: f.validation_rules,
      })),
      todaySubmission,
    });
  } catch (err) {
    console.error('Checkin template error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// POST /api/patient/checkins/:checkinTemplateVersionId/submit
app.post('/api/patient/checkins/:checkinTemplateVersionId/submit', authenticate, async (req, res) => {
  const { checkinTemplateVersionId } = req.params;
  const { values } = req.body; // array of { fieldId, value, numericValue?, textValue?, booleanValue? }

  if (!values || !Array.isArray(values)) {
    return res.status(400).json({ error: 'Values array is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const enrollment = await getActiveEnrollment(client, req.user.userId);
    if (!enrollment) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No active enrollment found' });
    }

    let resolvedParamId = checkinTemplateVersionId;
    let isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(resolvedParamId);

    if (isUUID) {
      const moduleRes = await client.query(`SELECT content FROM content_module_versions WHERE module_id = $1 ORDER BY version_number DESC LIMIT 1`, [resolvedParamId]);
      if (moduleRes.rows.length > 0 && moduleRes.rows[0].content && moduleRes.rows[0].content.checkinTemplateId) {
        resolvedParamId = moduleRes.rows[0].content.checkinTemplateId;
        isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(resolvedParamId);
      }
    }

    const ctvFallbackResult = await client.query(
      `SELECT fctv.id FROM forms_checkin_template_versions fctv
       JOIN forms_checkin_templates fct ON fct.id = fctv.checkin_template_id
       WHERE (fct.name = $1 OR fctv.id::text = $2 OR fct.id::text = $2)
         AND fct.app_id = $3
       ORDER BY fctv.version_number DESC LIMIT 1`,
      [resolvedParamId, isUUID ? resolvedParamId : '00000000-0000-0000-0000-000000000000', APP_ID]
    );

    if (ctvFallbackResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Check-in template not found' });
    }
    const resolvedVersionId = ctvFallbackResult.rows[0].id;

    const today = todayStr();

    // Check if already submitted today
    const existingSubmission = await client.query(
      `SELECT id FROM patient_checkin_submissions
       WHERE enrollment_id = $1
         AND patient_user_id = $2
         AND checkin_template_version_id = $3
         AND app_id = $4
         AND checkin_date = $5`,
      [enrollment.id, req.user.userId, resolvedVersionId, APP_ID, today]
    );

    if (existingSubmission.rows.length > 0) {
      const oldSubmissionId = existingSubmission.rows[0].id;
      // Delete old submission values and the submission itself
      await client.query('DELETE FROM patient_checkin_values WHERE submission_id = $1', [oldSubmissionId]);
      await client.query('DELETE FROM patient_checkin_submissions WHERE id = $1', [oldSubmissionId]);
      // We also might want to decrement streak if it's the exact same day, but we'll just let the new insert keep it same.
    }

    // Get current streak
    const streakResult = await client.query(
      `SELECT * FROM patient_streaks
       WHERE patient_user_id = $1
         AND enrollment_id = $2
         AND app_id = $3
         AND streak_type = 'checkin'
       LIMIT 1`,
      [req.user.userId, enrollment.id, APP_ID]
    );

    let currentStreak = 0;
    let longestStreak = 0;
    let streakDay = 1;

    if (streakResult.rows.length > 0) {
      const streak = streakResult.rows[0];
      const lastDate = streak.last_completed_date;
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];

      if (lastDate && lastDate.toISOString().split('T')[0] === yesterdayStr) {
        // Consecutive day
        currentStreak = (streak.current_streak || 0) + 1;
      } else if (lastDate && lastDate.toISOString().split('T')[0] === today) {
        // Same day (shouldn't happen due to check above)
        currentStreak = streak.current_streak || 0;
      } else {
        // Streak broken
        currentStreak = 1;
      }
      longestStreak = Math.max(streak.longest_streak || 0, currentStreak);
      streakDay = currentStreak;
    } else {
      currentStreak = 1;
      longestStreak = 1;
      streakDay = 1;
    }

    // Create submission
    const submissionResult = await client.query(
      `INSERT INTO patient_checkin_submissions
         (id, enrollment_id, patient_user_id, app_id, app_version_id,
          checkin_template_version_id, checkin_date, submitted_at,
          streak_day, risk_level, metadata)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, NOW(), $7, 'low', $8)
       RETURNING *`,
      [
        enrollment.id,
        req.user.userId,
        APP_ID,
        enrollment.app_version_id,
        resolvedVersionId,
        today,
        streakDay,
        JSON.stringify({ submittedAt: new Date().toISOString() }),
      ]
    );

    const submissionId = submissionResult.rows[0].id;

    const fieldsRes = await client.query(
      `SELECT id, field_key, field_type FROM forms_checkin_fields WHERE checkin_template_version_id = $1`,
      [resolvedVersionId]
    );
    const fieldMap = {};
    for (const f of fieldsRes.rows) {
      if (f.field_key) fieldMap[f.field_key] = f;
      fieldMap[f.id] = f;
    }

    // Insert values
    for (const val of values) {
      const field = fieldMap[val.fieldId] || fieldMap[val.fieldKey];
      if (!field) continue;

      const fieldId = field.id;
      const fieldType = field.field_type;

      let numVal = val.numericValue !== undefined ? val.numericValue : null;
      let boolVal = val.booleanValue !== undefined ? val.booleanValue : null;
      let textVal = val.textValue !== undefined ? val.textValue : null;

      if (val.value !== undefined && val.value !== null) {
        if (fieldType === 'number' || fieldType === 'scale' || fieldType === 'slider') {
          if (numVal === null) numVal = parseFloat(val.value);
          if (isNaN(numVal)) numVal = null;
        } else if (fieldType === 'boolean') {
          if (boolVal === null) boolVal = val.value === true || val.value === 'true';
        } else {
          if (textVal === null) textVal = String(val.value);
        }
      }

      await client.query(
        `INSERT INTO patient_checkin_values
           (id, submission_id, field_id, value, numeric_value, text_value, boolean_value, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, NOW())`,
        [
          submissionId,
          fieldId,
          JSON.stringify(val.value),
          numVal,
          textVal,
          boolVal,
        ]
      );
    }

    // Update or insert streak
    if (streakResult.rows.length > 0) {
      await client.query(
        `UPDATE patient_streaks
         SET current_streak = $1,
             longest_streak = $2,
             last_completed_date = $3,
             updated_at = NOW()
         WHERE id = $4`,
        [currentStreak, longestStreak, today, streakResult.rows[0].id]
      );
    } else {
      await client.query(
        `INSERT INTO patient_streaks
           (id, patient_user_id, enrollment_id, app_id, app_version_id,
            streak_type, current_streak, longest_streak, last_completed_date,
            freeze_count, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'checkin', $5, $6, $7, 0, NOW())`,
        [
          req.user.userId,
          enrollment.id,
          APP_ID,
          enrollment.app_version_id,
          currentStreak,
          longestStreak,
          today,
        ]
      );
    }

    await client.query('COMMIT');

    res.json({
      success: true,
      submission: submissionResult.rows[0],
      streak: {
        currentStreak,
        longestStreak,
        lastCompletedDate: today,
        streakDay,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Checkin submit error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ─── PROGRESS ────────────────────────────────────────────────────────────────

// GET /api/patient/progress
app.get('/api/patient/progress', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    const enrollment = await getActiveEnrollment(client, req.user.userId);
    if (!enrollment) {
      return res.status(404).json({ error: 'No active enrollment found' });
    }

    // Total journey steps
    const totalStepsResult = await client.query(
      `SELECT COUNT(*) AS total FROM content_journey_steps WHERE journey_id = $1`,
      [enrollment.journey_id]
    );

    // Completed modules
    const completedResult = await client.query(
      `SELECT pmp.id, pmp.module_version_id, pmp.status, pmp.completed_at, pmp.progress_percent,
              cmv.title AS module_title,
              cm.name AS module_name,
              cmt.code AS module_type
       FROM patient_module_progress pmp
       JOIN content_module_versions cmv ON cmv.id = pmp.module_version_id
       JOIN content_modules cm ON cm.id = cmv.module_id
       JOIN content_module_types cmt ON cmt.id = cm.module_type_id
       WHERE pmp.enrollment_id = $1
         AND pmp.patient_user_id = $2
         AND pmp.app_id = $3
       ORDER BY pmp.completed_at DESC NULLS LAST`,
      [enrollment.id, req.user.userId, APP_ID]
    );

    // Day-by-day breakdown
    const dayBreakdownResult = await client.query(
      `SELECT cjs.day_number, COUNT(*) AS total_steps,
              COUNT(pmp.id) FILTER (WHERE pmp.status = 'completed') AS completed_steps
       FROM content_journey_steps cjs
       LEFT JOIN content_module_versions cmv ON cmv.module_id = cjs.module_id
       LEFT JOIN patient_module_progress pmp
         ON pmp.module_version_id = cmv.id
         AND pmp.enrollment_id = $1
         AND pmp.patient_user_id = $2
         AND pmp.app_id = $3
       WHERE cjs.journey_id = $4
       GROUP BY cjs.day_number
       ORDER BY cjs.day_number ASC`,
      [enrollment.id, req.user.userId, APP_ID, enrollment.journey_id]
    );

    const totalSteps = parseInt(totalStepsResult.rows[0].total) || 1;
    const completedCount = completedResult.rows.filter((r) => r.status === 'completed').length;

    res.json({
      enrollment: {
        id: enrollment.id,
        currentDay: enrollment.current_day,
        progressPercent: enrollment.progress_percent,
        startDate: enrollment.start_date,
        endDate: enrollment.end_date,
      },
      totalSteps,
      completedModules: completedCount,
      progressPercent: Math.round((completedCount / totalSteps) * 100),
      moduleProgress: completedResult.rows,
      dayBreakdown: dayBreakdownResult.rows,
    });
  } catch (err) {
    console.error('Progress error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ─── NOTIFICATIONS ───────────────────────────────────────────────────────────

// GET /api/patient/notifications
app.get('/api/patient/notifications', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    const limit = parseInt(req.query.limit) || 20;
    const offset = parseInt(req.query.offset) || 0;

    const result = await client.query(
      `SELECT id, enrollment_id, channel, title, body, status,
              scheduled_at, sent_at, read_at, metadata, created_at
       FROM patient_notifications
       WHERE user_id = $1
         AND app_id = $2
       ORDER BY created_at DESC
       LIMIT $3 OFFSET $4`,
      [req.user.userId, APP_ID, limit, offset]
    );

    const countResult = await client.query(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE read_at IS NULL AND status != 'cancelled') AS unread
       FROM patient_notifications
       WHERE user_id = $1 AND app_id = $2`,
      [req.user.userId, APP_ID]
    );

    res.json({
      notifications: result.rows,
      total: parseInt(countResult.rows[0].total),
      unread: parseInt(countResult.rows[0].unread),
    });
  } catch (err) {
    console.error('Notifications error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// POST /api/patient/notifications/:id/read
app.post('/api/patient/notifications/:id/read', authenticate, async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    const result = await client.query(
      `UPDATE patient_notifications
       SET read_at = NOW(), status = 'read'
       WHERE id = $1 AND user_id = $2 AND app_id = $3
       RETURNING *`,
      [id, req.user.userId, APP_ID]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    res.json({ success: true, notification: result.rows[0] });
  } catch (err) {
    console.error('Notification read error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ─── CONSENT ENDPOINTS ──────────────────────────────────────────────────────

// GET /api/patient/consents
app.get('/api/patient/consents', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    // Get all required consent documents
    const docsResult = await client.query(
      `SELECT id, code, title, content_html, version_number, document_type,
              is_required, status, published_at, created_at
       FROM core_consent_documents
       WHERE status = 'published'
         AND is_required = true
       ORDER BY created_at ASC`
    );

    // Get user's accepted consents
    const acceptedResult = await client.query(
      `SELECT consent_document_id, accepted_at
       FROM patient_consents
       WHERE patient_user_id = $1`,
      [req.user.userId]
    );

    const acceptedMap = {};
    for (const a of acceptedResult.rows) {
      acceptedMap[a.consent_document_id] = a.accepted_at;
    }

    const documents = docsResult.rows.map((doc) => ({
      id: doc.id,
      code: doc.code,
      title: doc.title,
      contentHtml: doc.content_html,
      versionNumber: doc.version_number,
      documentType: doc.document_type,
      isRequired: doc.is_required,
      publishedAt: doc.published_at,
      accepted: !!acceptedMap[doc.id],
      acceptedAt: acceptedMap[doc.id] || null,
    }));

    const allAccepted = documents.every((d) => d.accepted);

    res.json({
      documents,
      allAccepted,
      totalRequired: documents.length,
      totalAccepted: documents.filter((d) => d.accepted).length,
    });
  } catch (err) {
    console.error('Consents error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// POST /api/patient/consents/:documentId/accept
app.post('/api/patient/consents/:documentId/accept', authenticate, async (req, res) => {
  const { documentId } = req.params;
  const client = await pool.connect();
  try {
    // Check document exists
    const docResult = await client.query(
      `SELECT id, title FROM core_consent_documents WHERE id = $1 AND status = 'published'`,
      [documentId]
    );

    if (docResult.rows.length === 0) {
      return res.status(404).json({ error: 'Consent document not found' });
    }

    // Check if already accepted
    const existing = await client.query(
      `SELECT id FROM patient_consents
       WHERE patient_user_id = $1 AND consent_document_id = $2`,
      [req.user.userId, documentId]
    );

    if (existing.rows.length > 0) {
      return res.json({ success: true, message: 'Consent already accepted' });
    }

    // Insert consent acceptance
    await client.query(
      `INSERT INTO patient_consents (patient_user_id, consent_document_id, accepted_at)
       VALUES ($1, $2, NOW())`,
      [req.user.userId, documentId]
    );

    // Log to audit
    try {
      await client.query(
        `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, metadata, created_at)
         VALUES ($1, 'consent_accepted', 'consent_document', $2, $3, NOW())`,
        [
          req.user.userId,
          documentId,
          JSON.stringify({ documentTitle: docResult.rows[0].title }),
        ]
      );
    } catch (auditErr) {
      // Don't fail the request if audit logging fails
      console.warn('Audit log failed:', auditErr.message);
    }

    res.json({ success: true, message: 'Consent accepted' });
  } catch (err) {
    console.error('Consent accept error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ─── STREAK ──────────────────────────────────────────────────────────────────

// GET /api/patient/streak
app.get('/api/patient/streak', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    const enrollment = await getActiveEnrollment(client, req.user.userId);
    if (!enrollment) {
      return res.status(404).json({ error: 'No active enrollment found' });
    }

    const streakResult = await client.query(
      `SELECT id, streak_type, current_streak, longest_streak,
              last_completed_date, freeze_count, updated_at
       FROM patient_streaks
       WHERE patient_user_id = $1
         AND enrollment_id = $2
         AND app_id = $3
       ORDER BY updated_at DESC`,
      [req.user.userId, enrollment.id, APP_ID]
    );

    // Also get recent checkin history (last 7 days)
    const recentCheckins = await client.query(
      `SELECT checkin_date, streak_day, submitted_at
       FROM patient_checkin_submissions
       WHERE enrollment_id = $1
         AND patient_user_id = $2
         AND app_id = $3
       ORDER BY checkin_date DESC
       LIMIT 7`,
      [enrollment.id, req.user.userId, APP_ID]
    );

    const primaryStreak = streakResult.rows[0] || {
      current_streak: 0,
      longest_streak: 0,
      last_completed_date: null,
      freeze_count: 0,
    };

    res.json({
      streak: {
        currentStreak: primaryStreak.current_streak,
        longestStreak: primaryStreak.longest_streak,
        lastCompletedDate: primaryStreak.last_completed_date,
        freezeCount: primaryStreak.freeze_count,
        streakType: primaryStreak.streak_type || 'checkin',
      },
      allStreaks: streakResult.rows,
      recentCheckins: recentCheckins.rows,
    });
  } catch (err) {
    console.error('Streak error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ─── HEALTH CHECK ────────────────────────────────────────────────────────────

app.get('/api/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW() AS server_time');
    res.json({
      status: 'ok',
      serverTime: result.rows[0].server_time,
      appId: APP_ID,
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─── 404 Handler ─────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// ─── Error Handler ───────────────────────────────────────────────────────────

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Start Server ────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`NaviKont API server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
  console.log(`App ID: ${APP_ID}`);
});
