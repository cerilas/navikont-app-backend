/**
 * Fix content quality issues in Days 1-15:
 * 1. undefined HTML → replace with proper title-based content
 * 2. Page numbers / production notes leaking into content
 * 3. Broken <br> line breaks inside words (mid-sentence breaks)
 * 4. Meaningless production document text in content
 * 5. Podcast/optional screens that don't belong in the day's content
 */

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const JOURNEY_ID = '56ba9baa-ac3a-425d-9949-1bbc60c2ba15';

// Patterns that indicate production/document noise
const NOISE_PATTERNS = [
  /Navikont M\d Digital Production Package/,
  /NAVIKONT \| MODÜL \d \| TAM DİJİTAL/,
  /Sayfa \d+/,
  /FINAL LOCKED v\d/,
  /Çalışma paketi/,
  /######\s*(Statü|Optional|Core)/,
  /^##+\s/m,
  /optional\. Tamamlanması M\d geçişini etkilemez/i,
  /Kaynak hikâyesi veya görseli kopyalanmamıştır/,
];

function isNoisyContent(html) {
  if (!html) return true;
  const text = html.replace(/<[^>]+>/g, '');
  return NOISE_PATTERNS.some(p => p.test(text));
}

function fixLineBreaks(html) {
  if (!html) return html;
  // Remove <br> that splits a word mid-sentence (letter before + letter after)
  // e.g. "güçlü ve<br>ertelemesi" → "güçlü ve ertelemesi"
  return html
    .replace(/<br>\s*([a-züğışçöA-ZÜĞİŞÇÖ])/g, ' $1')   // <br> before lowercase/uppercase Turkish
    .replace(/([a-züğışçöA-ZÜĞİŞÇÖ,;])\s*<br>\s*([a-züğışçöA-ZÜĞİŞÇÖ])/g, '$1 $2')
    .replace(/\s{2,}/g, ' ')
    .replace(/<p>\s*<\/p>/g, '')  // empty paragraphs
    .trim();
}

// Curated fallback content for known "empty" screens
const FALLBACK_CONTENT = {
  'Sizi en çok zorlayan alan hangisi?': {
    html: `<p class="key-message"><strong>Her bireyin OAB deneyimi farklıdır.</strong></p>
<p>OAB belirtileri kişiden kişiye büyük farklılık gösterir. Kimisi en çok uyku sorununu yaşarken, kimisi için sosyal yaşam ya da iş hayatı daha fazla etkilenebilir.</p>
<p>Aşağıdaki alanlardan hangisi sizi en fazla zorluyor?</p>
<ul>
<li>Uyku ve gece uyanmaları</li>
<li>İş veya okul hayatı</li>
<li>Sosyal etkinlikler ve dışarı çıkma</li>
<li>Egzersiz ve fiziksel aktivite</li>
<li>Yakın ilişkiler</li>
</ul>
<p>Bu bilgiyi klinisyeninizle paylaşmak, tedavi hedefinizin belirlenmesinde önemli bir rol oynar.</p>`,
    readTime: 2
  },
  'Klinik görüşmeye hazırlanıyorum': {
    html: `<p class="key-message"><strong>Doktor görüşmenizden en iyi şekilde yararlanabilirsiniz.</strong></p>
<p>Klinik görüşmelerinizde şu konuları gündeme getirmeyi düşünebilirsiniz:</p>
<ul>
<li>En çok sizi zorlayan belirti veya durum</li>
<li>Günlük yaşamınızda en belirgin değişiklik yaşadığınız alan</li>
<li>Daha önce denediğiniz yöntemler ve sonuçları</li>
<li>Tedaviden beklentileriniz</li>
</ul>
<p>Görüşme sırasında sormak istediğiniz soruları önceden not etmek, zaman baskısı olmadan düşüncelerinizi aktarmanıza yardımcı olabilir.</p>
<p>Navikont bu bilgileri doğrudan klinisyeninize iletmez; paylaşmak istediğiniz bilgileri siz aktarırsınız.</p>`,
    readTime: 2
  },
  'Teknik yardım': {
    html: `<p class="key-message"><strong>Teknik bir sorunla mı karşılaştınız?</strong></p>
<p>Aşağıdaki durumlar teknik destek kapsamındadır:</p>
<ul>
<li>Uygulamaya giriş veya aktivasyon sorunu</li>
<li>İçerik açılmıyor veya yüklenmiyor</li>
<li>Ses veya video çalışmıyor</li>
<li>Kayıt sistemi hata veriyor</li>
<li>Bildirimler gelmiyor</li>
</ul>
<p>Teknik destek hattına ulaşmak için uygulama içindeki <strong>Yardım</strong> menüsünü kullanabilir ya da kayıt olurken size iletilen teknik destek bilgilerini kullanabilirsiniz.</p>
<p><em>Not: Teknik destek belirtilerinizi yorumlamaz ve tedavi önerisinde bulunmaz.</em></p>`,
    readTime: 2
  },
  'Klinik ekibime ulaşmalıyım': {
    html: `<p class="key-message"><strong>Klinik ekibinize ulaşmak için doğru yolu kullanın.</strong></p>
<p>Aşağıdaki durumlarda klinik ekibinizle iletişime geçmeniz önerilir:</p>
<ul>
<li>Belirtilerinizde beklenmedik bir değişiklik</li>
<li>Yeni veya farklı bir semptom</li>
<li>Plan veya tedavi hakkında sorunuz</li>
<li>Uygulamaya yansımayan bir klinik durum</li>
</ul>
<p>Klinik ekibinize kayıt olurken size iletilen iletişim kanalları üzerinden ulaşabilirsiniz. Acil bir durum söz konusuysa uygulamadan değil, doğrudan sağlık hizmetlerinden yardım isteyin.</p>`,
    readTime: 2
  },
  'Acil yardım gerekebilir': {
    html: `<p class="key-message"><strong>Acil bir durum yaşıyorsanız uygulamayı beklemeyin.</strong></p>
<p>Aşağıdaki belirtilerden herhangi birini yaşıyorsanız derhal acil sağlık hizmetlerine başvurun:</p>
<ul>
<li>İdrarda gözle görülür kan</li>
<li>Şiddetli ağrı veya genel durum bozukluğu</li>
<li>Yüksek ateş ile birlikte üriner şikayetler</li>
<li>İdrar yapamama (tam retansiyon)</li>
<li>Bacaklarda his kaybı veya ani güçsüzlük</li>
</ul>
<p>Bu durumlarda Navikont veya klinik ekibinizi beklemeyin. Yerel acil numaranızı (Türkiye: 112) arayın veya en yakın acil servise gidin.</p>`,
    readTime: 2
  },
  'Optional mikro-senaryo tam video/animasyon senaryo': {
    html: `<p class="key-message"><strong>Günlük yaşamda OAB ile baş etme: Gerçek senaryolar</strong></p>
<p>Bu bölümde, OAB belirtilerini olan kişilerin sık yaşadığı durumlara ilişkin kısa senaryolar bulunmaktadır. Her senaryo gerçek bir durumu yansıtmakta ve nasıl yaklaşılabileceğini göstermektedir.</p>
<p><strong>Senaryo örneği:</strong> Toplantı ortasında ani sıkışma hissi</p>
<p>Bir toplantı sırasında ani bir sıkışma hissi geldiğinde paniğe kapılmak durumu daha da zorlaştırabilir. Öğreneceğiniz teknikler bu gibi anlarda sakin kalmanıza ve güvenli biçimde hareket etmenize yardımcı olmak için tasarlanmıştır.</p>
<p>İlerleyen modüllerde bu ve benzeri senaryoları adım adım ele alacaksınız.</p>`,
    readTime: 2
  },
};

function buildFallbackHtml(title, subtitle) {
  // Generic clean fallback based on title
  return `<p class="key-message"><strong>${title}</strong></p>
<p>${subtitle || `Bu bölümde ${title.toLowerCase()} konusu ele alınmaktadır.`}</p>`;
}

async function fixDays() {
  const client = await pool.connect();
  try {
    // Get all steps days 1-15 with their content
    const res = await client.query(`
      SELECT 
        cjs.id as step_id,
        cjs.day_number,
        cjs.order_in_day,
        cm.id as module_id,
        cmv.id as version_id,
        cmv.title,
        cmv.subtitle,
        cmv.content,
        cmt.code as type_code
      FROM content_journey_steps cjs
      JOIN content_modules cm ON cm.id = cjs.module_id
      JOIN content_module_versions cmv ON cmv.module_id = cm.id
      JOIN content_module_types cmt ON cmt.id = cm.module_type_id
      WHERE cjs.journey_id = $1
        AND cjs.day_number BETWEEN 1 AND 15
      ORDER BY cjs.day_number, cjs.order_in_day
    `, [JOURNEY_ID]);

    console.log(`Found ${res.rows.length} steps in Days 1-15`);
    
    await client.query('BEGIN');

    let fixed = 0;
    let skipped = 0;

    for (const row of res.rows) {
      const content = row.content || {};
      const typeCode = row.type_code;
      const title = row.title || '';
      const subtitle = row.subtitle || '';
      
      let needsFix = false;
      let newContent = { ...content };

      if (typeCode === 'html_content') {
        let html = content.html || '';
        
        // Check for undefined
        if (!html || html === '<p>undefined</p>' || html.trim() === '<p></p>' || html.includes('>undefined<')) {
          needsFix = true;
          // Try to find curated fallback
          const fallbackKey = Object.keys(FALLBACK_CONTENT).find(k => title.includes(k) || k.includes(title.substring(0, 20)));
          if (fallbackKey) {
            newContent = { ...FALLBACK_CONTENT[fallbackKey], _navikont: content._navikont };
          } else {
            newContent = {
              html: buildFallbackHtml(title, subtitle),
              readTime: 2,
              _navikont: content._navikont
            };
          }
        }
        // Check for production noise
        else if (isNoisyContent(html)) {
          needsFix = true;
          const fallbackKey = Object.keys(FALLBACK_CONTENT).find(k => title.includes(k.substring(0, 15)) || k.includes(title.substring(0, 15)));
          if (fallbackKey) {
            newContent = { ...FALLBACK_CONTENT[fallbackKey], _navikont: content._navikont };
          } else {
            // Strip noise and keep whatever clean text remains
            const cleanText = html
              .replace(/<[^>]+>/g, ' ')  // strip tags
              .replace(/Navikont M\d Digital Production Package.*$/gm, '')
              .replace(/NAVIKONT \| MODÜL.*$/gm, '')
              .replace(/Sayfa \d+/g, '')
              .replace(/Çalışma paketi/g, '')
              .replace(/FINAL LOCKED v[\d.]+/g, '')
              .replace(/#{2,}.*/g, '')
              .replace(/\s{2,}/g, ' ')
              .trim();
            
            if (cleanText.length > 30) {
              newContent = {
                html: `<p>${cleanText}</p>`,
                readTime: Math.max(1, Math.ceil(cleanText.length / 500)),
                _navikont: content._navikont
              };
            } else {
              newContent = {
                html: buildFallbackHtml(title, subtitle),
                readTime: 2,
                _navikont: content._navikont
              };
            }
          }
        }
        // Fix broken line breaks (mid-word <br>)
        else {
          const fixedHtml = fixLineBreaks(html);
          if (fixedHtml !== html) {
            needsFix = true;
            newContent = { ...content, html: fixedHtml };
          }
        }
      }
      else if (typeCode === 'task') {
        // Fix undefined task fields
        if (!content.taskName || content.taskName === 'undefined') {
          needsFix = true;
          newContent = {
            taskName: title,
            estimatedDuration: content.estimatedDuration || 10,
            instructions: content.instructions && content.instructions !== 'undefined'
              ? content.instructions
              : subtitle || `${title} görevini tamamlayın.`,
            _navikont: content._navikont
          };
        }
      }
      else if (typeCode === 'quiz') {
        const questions = content.questions || [];
        const hasIssues = questions.some(q => 
          !q.text || q.text === 'undefined' || 
          !q.options || q.options.length < 2 ||
          q.options.some(o => !o || o === 'undefined')
        );
        if (hasIssues) {
          needsFix = true;
          // Build clean quiz from _navikont data or title
          const navData = content._navikont || {};
          const questionText = navData.question_text && navData.question_text !== 'undefined'
            ? navData.question_text
            : `${title} hakkında hangisi doğrudur?`;
          const optionsText = navData.options || '';
          
          let opts = [];
          if (optionsText && optionsText !== 'undefined') {
            const lines = optionsText.split('\n').filter(l => l.trim());
            opts = lines.map(l => l.replace(/^[A-Da-d\d][\.\)]\s*/, '').trim()).filter(l => l);
          }
          if (opts.length < 2) opts = ['Doğru', 'Yanlış'];
          
          newContent = {
            questions: [{
              id: `q_${row.version_id.substring(0, 8)}`,
              text: questionText,
              type: 'single_choice',
              options: opts,
              correctOptionIndex: 0,
              explanation: (navData.correct_feedback && navData.correct_feedback !== 'undefined') 
                ? navData.correct_feedback : ''
            }],
            _navikont: content._navikont
          };
        }
      }

      if (needsFix) {
        await client.query(
          `UPDATE content_module_versions SET content = $1 WHERE id = $2`,
          [JSON.stringify(newContent), row.version_id]
        );
        console.log(`  ✅ Fixed Day ${row.day_number}/${row.order_in_day} [${typeCode}]: ${title.substring(0, 50)}`);
        fixed++;
      } else {
        skipped++;
      }
    }

    await client.query('COMMIT');
    console.log(`\n✅ Done! Fixed: ${fixed}, Already OK: ${skipped}`);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Error:', err.message, err);
  } finally {
    client.release();
    pool.end();
  }
}

fixDays();
