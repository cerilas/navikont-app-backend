/**
 * NaviKont Eligibility Screening & Conditional Assignment Seeder
 *
 * Creates:
 * 1. Red Flag Safety Screen questionnaire (5 yes/no questions — any "yes" = ineligible)
 * 2. OAB Symptom Eligibility questionnaire (6 scored questions — threshold >= 3 = eligible)
 * 3. Module versions for both questionnaires (question_answer type)
 * 4. Day 0 prerequisite journey steps linking to both questionnaires
 */

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const APP_ID          = process.env.NAVIKONT_APP_ID;
const JOURNEY_ID      = '56ba9baa-ac3a-425d-9949-1bbc60c2ba15';

async function seed() {
  const client = await pool.connect();
  try {
    // ── Lookups ────────────────────────────────────────────────────────────────
    const versionRes = await client.query(
      `SELECT id FROM content_app_versions WHERE app_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [APP_ID]
    );
    const APP_VERSION_ID = versionRes.rows[0].id;

    const typeRes = await client.query(`SELECT id, code FROM content_module_types`);
    const typeByCode = Object.fromEntries(typeRes.rows.map(r => [r.code, r.id]));
    const QA_TYPE_ID   = typeByCode['question_answer'];  // question_answer module type
    const HTML_TYPE_ID = typeByCode['html_content'];

    console.log('App version:', APP_VERSION_ID);
    console.log('question_answer type id:', QA_TYPE_ID);

    await client.query('BEGIN');

    // ══════════════════════════════════════════════════════════════════════════
    // STEP 1 — Red Flag Safety Screen Questionnaire
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[1/4] Creating Red Flag Safety Screen questionnaire...');

    // Delete old if exists (to re-seed cleanly)
    await client.query(
      `DELETE FROM forms_questionnaires WHERE app_id=$1 AND name=$2`,
      [APP_ID, 'Güvenlik Tarama — Red Flag']
    );

    const redFlagQRes = await client.query(
      `INSERT INTO forms_questionnaires (id, app_id, name, description, questionnaire_type, status)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'published')
       RETURNING id`,
      [APP_ID,
       'Güvenlik Tarama — Red Flag',
       'Programa başlamadan önce güvenlik açısından risk oluşturabilecek semptomları tarar. Herhangi bir soruya "Evet" yanıtı verilirse hasta klinik ekibe yönlendirilir.',
       'screening']
    );
    const RED_FLAG_Q_ID = redFlagQRes.rows[0].id;

    const redFlagVersionRes = await client.query(
      `INSERT INTO forms_questionnaire_versions
         (id, questionnaire_id, app_version_id, version_number, title, description_html, scoring_method, risk_rules, status)
       VALUES (gen_random_uuid(), $1, $2, 1, $3, $4, $5, $6, 'published')
       RETURNING id`,
      [
        RED_FLAG_Q_ID, APP_VERSION_ID,
        'Güvenlik Tarama Testi',
        '<p>Programımıza başlamadan önce lütfen aşağıdaki soruları dürüstçe yanıtlayın. Bu sorular sizin güvenliğiniz için sorulmaktadır.</p>',
        JSON.stringify({ method: 'any_flag', flag_value: 'yes' }),  // any "yes" = flagged
        JSON.stringify({
          flag_threshold: 1,  // >= 1 "yes" = risk
          flag_action: 'ineligible',
          ineligible_message: 'Yanıtlarınız incelendi. Belirttiğiniz semptomlar bu programın kapsamı dışında kalıyor olabilir. Lütfen klinik ekibinizle iletişime geçin. Programımız ayrı bir tedavinin yerini almaz.',
          ineligible_cta: 'Klinik Ekibime Ulaş'
        })
      ]
    );
    const RED_FLAG_VERSION_ID = redFlagVersionRes.rows[0].id;

    // Red flag questions
    const redFlagQuestions = [
      {
        key: 'red_flag_blood',
        label: 'İdrarınızda gözle görülür kırmızı veya kahverengi renk fark ettiniz mi?',
        description_html: '<p><strong>İdrarda kan (hematüri)</strong> klinik değerlendirme gerektiren bir bulgudur.</p>',
        options: [
          { value: 'yes', label: 'Evet, fark ettim', score: 1 },
          { value: 'no',  label: 'Hayır', score: 0 },
        ]
      },
      {
        key: 'red_flag_pain',
        label: 'İdrar yaparken yeni başlayan belirgin yanma veya ağrı hissediyor musunuz?',
        description_html: '<p>Uzun süredir olan hafif rahatsızlıklar değil, <strong>yeni başlayan ve belirgin</strong> bir yanma/ağrı kastedilmektedir.</p>',
        options: [
          { value: 'yes', label: 'Evet, yeni ve belirgin bir ağrı/yanma var', score: 1 },
          { value: 'no',  label: 'Hayır', score: 0 },
        ]
      },
      {
        key: 'red_flag_retention',
        label: 'İdrar yapmak istemenize rağmen hiç idrar yapamadığınız oldu mu?',
        description_html: '<p><strong>İdrar retansiyonu</strong> acil tıbbi değerlendirme gerektiren bir durumdur.</p>',
        options: [
          { value: 'yes', label: 'Evet, oldu', score: 1 },
          { value: 'no',  label: 'Hayır', score: 0 },
        ]
      },
      {
        key: 'red_flag_fever',
        label: 'İdrar yakınmalarınızla birlikte ateş (38°C üzeri) yaşıyor musunuz?',
        description_html: '<p>Ateşle birlikte görülen üriner semptomlar, <strong>klinik değerlendirme</strong> gerektiren enfeksiyon belirtisi olabilir.</p>',
        options: [
          { value: 'yes', label: 'Evet, ateşim var', score: 1 },
          { value: 'no',  label: 'Hayır', score: 0 },
        ]
      },
      {
        key: 'red_flag_neuro',
        label: 'Son iki haftada bacaklarınızda, kasıklarınızda veya genital bölgede his kaybı ya da beklenmedik bir güçsüzlük yaşadınız mı?',
        description_html: '<p>Bu belirtiler nörolojik değerlendirme gerektiren durumların işareti olabilir.</p>',
        options: [
          { value: 'yes', label: 'Evet, yaşadım', score: 1 },
          { value: 'no',  label: 'Hayır', score: 0 },
        ]
      },
    ];

    for (let i = 0; i < redFlagQuestions.length; i++) {
      const q = redFlagQuestions[i];
      const qRes = await client.query(
        `INSERT INTO forms_questions
           (id, questionnaire_version_id, question_key, question_type, label, description_html, is_required, sort_order)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, true, $6)
         RETURNING id`,
        [RED_FLAG_VERSION_ID, q.key, 'single_choice', q.label, q.description_html, i]
      );
      const questionId = qRes.rows[0].id;

      for (let j = 0; j < q.options.length; j++) {
        const opt = q.options[j];
        await client.query(
          `INSERT INTO forms_question_options (id, question_id, option_value, option_label, score, sort_order)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
          [questionId, opt.value, opt.label, opt.score, j]
        );
      }
    }

    console.log(`  ✅ Red flag questionnaire created (${redFlagQuestions.length} questions)`);

    // ══════════════════════════════════════════════════════════════════════════
    // STEP 2 — OAB Symptom Eligibility Questionnaire
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[2/4] Creating OAB Symptom Eligibility questionnaire...');

    await client.query(
      `DELETE FROM forms_questionnaires WHERE app_id=$1 AND name=$2`,
      [APP_ID, 'OAB Semptom Uygunluk Değerlendirmesi']
    );

    const oabQRes = await client.query(
      `INSERT INTO forms_questionnaires (id, app_id, name, description, questionnaire_type, status)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'published')
       RETURNING id`,
      [APP_ID,
       'OAB Semptom Uygunluk Değerlendirmesi',
       'Mesane belirtilerinizin bu programa uygunluğunu değerlendirir. Toplam skor 10 üzerinden hesaplanır; eşik 3 puan.',
       'eligibility']
    );
    const OAB_Q_ID = oabQRes.rows[0].id;

    const oabVersionRes = await client.query(
      `INSERT INTO forms_questionnaire_versions
         (id, questionnaire_id, app_version_id, version_number, title, description_html, scoring_method, risk_rules, status)
       VALUES (gen_random_uuid(), $1, $2, 1, $3, $4, $5, $6, 'published')
       RETURNING id`,
      [
        OAB_Q_ID, APP_VERSION_ID,
        'Mesane Belirti Değerlendirmesi',
        '<p>Aşağıdaki sorular mesane belirtilerinizi değerlendirmek için hazırlanmıştır. Lütfen son 4 haftanızı düşünerek yanıtlayın.</p>',
        JSON.stringify({ method: 'sum', max_score: 10 }),
        JSON.stringify({
          eligible_threshold: 3,   // score >= 3 → eligible
          eligible_action: 'enroll',
          ineligible_action: 'show_message',
          ineligible_message: 'Verdiğiniz yanıtlara göre belirtileriniz şu an bu program için uygun görünmüyor. Bu bir kesin tanı değildir. Belirtileriniz hakkında doktorunuzla görüşmenizi öneririz.',
          ineligible_cta: 'Doktorum Hakkında Bilgi Al',
          eligible_message: 'Belirtileriniz bu programa uygun görünüyor. Programınız hemen başlayabilir!'
        })
      ]
    );
    const OAB_VERSION_ID = oabVersionRes.rows[0].id;

    const oabQuestions = [
      {
        key: 'urinary_frequency',
        label: 'Gündüz kaç kez idrara çıkıyorsunuz? (uyku dışındaki saatler)',
        description_html: '<p>Son 4 haftanızı düşünerek ortalama günlük işeme sayınızı belirtin.</p>',
        options: [
          { value: '0_7',  label: '7 veya daha az', score: 0 },
          { value: '8_12', label: '8 ile 12 arası', score: 1 },
          { value: '13+',  label: '13 veya daha fazla', score: 2 },
        ]
      },
      {
        key: 'nocturia',
        label: 'Gece uyuduktan sonra idrara çıkmak için kaç kez uyanıyorsunuz?',
        description_html: '<p>Uyku döneminde idrara çıkmak için uyanma sayısı.</p>',
        options: [
          { value: '0',    label: 'Hiç uyanmıyorum', score: 0 },
          { value: '1_2',  label: '1 ile 2 kez', score: 1 },
          { value: '3+',   label: '3 veya daha fazla kez', score: 2 },
        ]
      },
      {
        key: 'urgency',
        label: 'Aniden gelen ve ertelemesi zor olan güçlü bir idrar yapma isteği (sıkışma hissi) yaşıyor musunuz?',
        description_html: '<p>Bu, OAB\'nin en temel belirtisidir. Aniden gelen ve bekletilmesi çok zor olan güçlü bir isteği tanımlar.</p>',
        options: [
          { value: 'never',      label: 'Hayır, yaşamıyorum', score: 0 },
          { value: 'sometimes',  label: 'Evet, haftada birkaç kez', score: 1 },
          { value: 'often',      label: 'Evet, çoğu gün veya her gün', score: 2 },
        ]
      },
      {
        key: 'urgency_incontinence',
        label: 'Bu ani sıkışma hissini tutamayıp idrar kaçırıyor musunuz?',
        description_html: '<p>Tuvalete yetişemeden yaşanan idrar kaçırma durumu.</p>',
        options: [
          { value: 'never',      label: 'Hayır, kaçırma yaşamıyorum', score: 0 },
          { value: 'sometimes',  label: 'Nadiren (ayda 1-2 kez)', score: 1 },
          { value: 'often',      label: 'Sık sık (haftada 1 kez veya daha fazla)', score: 2 },
        ]
      },
      {
        key: 'duration',
        label: 'Bu belirtiler ne zamandır sürüyor?',
        description_html: '',
        options: [
          { value: 'none',      label: 'Belirtim yok', score: 0 },
          { value: 'less_6mo', label: '6 aydan az', score: 1 },
          { value: 'over_6mo', label: '6 ay veya daha fazla', score: 2 },
        ]
      },
      {
        key: 'qol_impact',
        label: 'Mesane belirtileriniz günlük yaşamınızı ne kadar etkiliyor?',
        description_html: '<p>0 = hiç etkilemiyor, 3 = çok fazla etkiliyor</p>',
        options: [
          { value: '0', label: '0 — Hiç etkilemiyor', score: 0 },
          { value: '1', label: '1 — Az etkiliyor', score: 0 },
          { value: '2', label: '2 — Orta derecede etkiliyor', score: 1 },
          { value: '3', label: '3 — Çok fazla etkiliyor', score: 2 },
        ]
      },
    ];

    for (let i = 0; i < oabQuestions.length; i++) {
      const q = oabQuestions[i];
      const qRes = await client.query(
        `INSERT INTO forms_questions
           (id, questionnaire_version_id, question_key, question_type, label, description_html, is_required, sort_order)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, true, $6)
         RETURNING id`,
        [OAB_VERSION_ID, q.key, 'single_choice', q.label, q.description_html, i]
      );
      const questionId = qRes.rows[0].id;

      for (let j = 0; j < q.options.length; j++) {
        const opt = q.options[j];
        await client.query(
          `INSERT INTO forms_question_options (id, question_id, option_value, option_label, score, sort_order)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
          [questionId, opt.value, opt.label, opt.score, j]
        );
      }
    }

    console.log(`  ✅ OAB eligibility questionnaire created (${oabQuestions.length} questions, max 10 pts, threshold 3)`);

    // ══════════════════════════════════════════════════════════════════════════
    // STEP 3 — Create content_modules + versions for both questionnaires
    //          These are the "modules" that get linked as journey steps
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[3/4] Creating module wrappers for questionnaires...');

    // Remove old wrappers
    await client.query(
      `DELETE FROM content_module_versions WHERE title IN ($1, $2)`,
      ['Güvenlik Tarama Testi', 'Mesane Belirti Değerlendirmesi']
    );
    await client.query(
      `DELETE FROM content_modules WHERE internal_name IN ($1, $2)`,
      ['red_flag_screening', 'oab_eligibility_screening']
    );

    // Red flag module
    const redModRes = await client.query(
      `INSERT INTO content_modules (id, app_id, module_type_id, name, internal_name, description, status)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'published')
       RETURNING id`,
      [APP_ID, QA_TYPE_ID,
       'Güvenlik Tarama Testi',
       'red_flag_screening',
       'Programa başlamadan önce güvenlik açısından risk oluşturabilecek semptomları tarar']
    );
    const RED_MODULE_ID = redModRes.rows[0].id;

    await client.query(
      `INSERT INTO content_module_versions
         (id, module_id, app_version_id, version_number, title, subtitle, content, status)
       VALUES (gen_random_uuid(), $1, $2, 1, $3, $4, $5, 'published')`,
      [RED_MODULE_ID, APP_VERSION_ID,
       'Güvenlik Tarama Testi',
       'Başlamadan önce kısa bir güvenlik kontrolü',
       JSON.stringify({
         formId: RED_FLAG_Q_ID,
         questionnaireId: RED_FLAG_Q_ID,
         threshold: 1,           // any score >= 1 means a flag was raised
         riskAction: 'ineligible',
         type: 'red_flag_screen',
         intro_text: 'Programımıza başlamadan önce güvenliğinizi sağlamak amacıyla aşağıdaki birkaç soruyu yanıtlamanızı rica ederiz. Bu sorular tamamen sizin iyiliğiniz için sorulmaktadır.',
         ineligible_title: 'Klinik Değerlendirme Gerekiyor',
         ineligible_message: 'Belirttiğiniz semptomlar bu program başlamadan önce bir sağlık profesyoneli tarafından değerlendirilmelidir. Bu bir kesin tanı değildir; ancak güvenliğiniz için lütfen klinik ekibinize başvurun.',
         ineligible_cta: 'Klinik Ekibime Ulaş',
         eligible_cta: 'Devam Et',
       })
      ]
    );

    // OAB eligibility module
    const oabModRes = await client.query(
      `INSERT INTO content_modules (id, app_id, module_type_id, name, internal_name, description, status)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'published')
       RETURNING id`,
      [APP_ID, QA_TYPE_ID,
       'Mesane Belirti Değerlendirmesi',
       'oab_eligibility_screening',
       'Mesane belirtilerinizin bu programa uygunluğunu değerlendirir']
    );
    const OAB_MODULE_ID = oabModRes.rows[0].id;

    await client.query(
      `INSERT INTO content_module_versions
         (id, module_id, app_version_id, version_number, title, subtitle, content, status)
       VALUES (gen_random_uuid(), $1, $2, 1, $3, $4, $5, 'published')`,
      [OAB_MODULE_ID, APP_VERSION_ID,
       'Mesane Belirti Değerlendirmesi',
       'Programın size uygun olup olmadığını belirleyelim',
       JSON.stringify({
         formId: OAB_Q_ID,
         questionnaireId: OAB_Q_ID,
         threshold: 3,           // score >= 3 → eligible
         riskAction: 'ineligible',
         type: 'eligibility_screen',
         intro_text: 'Şimdi mesane belirtilerinizi değerlendirelim. Bu sorular programın size uygun olup olmadığını belirlememize yardımcı olacak. Son 4 haftanızı düşünerek yanıtlayın.',
         ineligible_title: 'Program Şu An Size Uygun Görünmüyor',
         ineligible_message: 'Verdiğiniz yanıtlara göre belirtileriniz bu program için yeterli düzeyde görünmüyor. Bu bir kesin tanı değildir. Mesane sağlığınız hakkında doktorunuzla görüşmenizi öneririz.',
         ineligible_cta: 'Doktoruma Ulaş',
         eligible_title: 'Programa Katılmaya Uygunsunuz',
         eligible_message: 'Belirtileriniz bu programa uygun görünüyor. Programınız başlıyor!',
         eligible_cta: 'Programı Başlat',
       })
      ]
    );

    console.log('  ✅ Module wrappers created for both questionnaires');

    // ══════════════════════════════════════════════════════════════════════════
    // STEP 4 — Insert Day 0 journey steps (before all existing Day 1+ steps)
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[4/4] Inserting Day 0 prerequisite journey steps...');

    // Remove any existing day 0 steps
    await client.query(
      `DELETE FROM content_journey_steps WHERE journey_id=$1 AND day_number=0`,
      [JOURNEY_ID]
    );

    // Insert red flag screen as Day 0, order 1
    await client.query(
      `INSERT INTO content_journey_steps (id, journey_id, module_id, day_number, order_in_day, is_required)
       VALUES (gen_random_uuid(), $1, $2, 0, 1, true)`,
      [JOURNEY_ID, RED_MODULE_ID]
    );

    // Insert OAB eligibility screen as Day 0, order 2
    await client.query(
      `INSERT INTO content_journey_steps (id, journey_id, module_id, day_number, order_in_day, is_required)
       VALUES (gen_random_uuid(), $1, $2, 0, 2, true)`,
      [JOURNEY_ID, OAB_MODULE_ID]
    );

    await client.query('COMMIT');

    console.log('\n✅ Eligibility screening setup complete!');
    console.log('');
    console.log('  Journey flow:');
    console.log('  Day 0, Step 1 → Red Flag Safety Screen (5 yes/no questions)');
    console.log('                   Any "yes" → "Klinik Değerlendirme Gerekiyor" + stop');
    console.log('  Day 0, Step 2 → OAB Symptom Screen (6 scored questions, max 10 pts)');
    console.log('                   Score >= 3 → Program starts (Day 1)');
    console.log('                   Score <  3 → "Program Şu An Size Uygun Görünmüyor" + stop');
    console.log('  Day 1+ → Navikont 90-day therapeutic journey');
    console.log('');
    console.log('  Red Flag Questionnaire ID:', RED_FLAG_Q_ID);
    console.log('  OAB Eligibility Questionnaire ID:', OAB_Q_ID);
    console.log('  Red Flag Module ID:', RED_MODULE_ID);
    console.log('  OAB Module ID:', OAB_MODULE_ID);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Error:', err.message);
    console.error(err);
  } finally {
    client.release();
    pool.end();
  }
}

seed();
