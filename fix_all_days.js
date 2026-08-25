/**
 * Bulk fix all content quality issues in Days 16-90:
 * - undefined content → meaningful fallbacks based on title/subtitle/module context
 * - Production document noise → stripped and replaced
 * - Mid-sentence <br> breaks → fixed to spaces
 * - Internal IDs as titles (HF-TASK-02, 001, etc.) → human readable titles + content
 */

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const JOURNEY_ID = '56ba9baa-ac3a-425d-9949-1bbc60c2ba15';

const NOISE_RE = [
  /Navikont M\d Digital Production Package[^\n]*/gi,
  /NAVIKONT \| MODÜL \d \| TAM DİJİTAL[^\n]*/gi,
  /Sayfa \d+\s*/g,
  /FINAL LOCKED v[\d.]+/gi,
  /Çalışma paketi/gi,
  /M\d-DIGI-v[\d.]+[^\n]*/gi,
  /#{2,}\s*\w[^\n]*/g,
  /Klinik içerik kilidi:[^\n]*/gi,
  /NAVIKONT MODÜL \d[^\n]*/gi,
  /\|\s*\*{0,2}[A-Za-z ]+\*{0,2}\s*\|[^\n]*/g,   // markdown table rows
];

function stripNoise(text) {
  let out = text;
  for (const re of NOISE_RE) out = out.replace(re, '');
  return out.replace(/\s{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function fixBreaks(html) {
  return html
    .replace(/<br>\s*([a-züğışçöA-ZÜĞİŞÇÖ,;])/g, ' $1')
    .replace(/([a-züğışçöA-ZÜĞİŞÇÖ,;:])\s*<br>\s*([a-züğışçöA-ZÜĞİŞÇÖ])/g, '$1 $2')
    .replace(/<p>\s*<\/p>/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Title → human readable mapping for internal IDs
function humanizeTitle(title, subtitle, day, type) {
  const t = (title || '').trim();
  const s = (subtitle || '').trim();

  // Timestamp-looking titles (e.g. "04:30–04:55", "06:10–06:45")
  if (/^\d{2}:\d{2}/.test(t)) {
    return { title: `${s || 'Modül'} — Sesli İçerik`, text: `Bu bölüm sesli anlatım içermektedir. Video veya podcast formatında dinleyebilirsiniz.` };
  }
  // Numeric IDs (001, 002, ...)
  if (/^\d{3}$/.test(t)) {
    return { title: `${s || 'Destek İçeriği'} ${t}`, text: `Bu içerik ${s || 'destek modülü'} kapsamında hazırlanmıştır.` };
  }
  // HF-TASK codes
  if (/^HF-TASK-\d+$/.test(t)) {
    const taskNum = parseInt(t.split('-')[2]);
    const tasks = [
      null,
      'Gerçek Yaşam Kaydı: Sıkışma Olayı', 'Beceri Değerlendirme: Ne İşe Yaradı?', 'Uygulama Güçlüğü Kaydı',
      'Plan Uyumu Değerlendirmesi', 'Haftalık Uygulama Özeti', 'Klinisyene İletilecek Notlar',
      'Destek Talebi Formu', 'Günlük Refah Kaydı', 'Belirtilerdeki Değişimi Gözlemle',
      'Haftalık Hedef Gözden Geçirme', 'Plan Uygulanabilirlik Değerlendirmesi', 'Son Uygulama Özeti',
    ];
    const humanTitle = tasks[taskNum] || `Görev ${taskNum}: ${s || 'Günlük Uygulama'}`;
    return { title: humanTitle, text: getTaskText(taskNum, s) };
  }
  // PFM codes
  if (t.includes('PFM-URG') || t.includes('ADJ-P1')) {
    return { title: 'Pelvik Taban Kaslarını Kullanan Teknik', text: 'Bu teknik yalnızca klinisyeniniz tarafından etkinleştirilmişse uygulanır. Doğru kas kasılmasını doğrulamadan bu egzersizi uygulamayın. Klinisyeninizin talimatlarını izleyin.' };
  }
  // Scenario codes
  if (t.toLowerCase().includes('scenario intro') || t.toLowerCase().includes('imagined latch')) {
    return { title: 'Senaryo: Günlük Yaşamda Sıkışma Hissi', text: 'Aşağıdaki senaryo gerçek bir durumu simüle etmektedir. Aklınızdan bu durumda nasıl davranacağınızı canlandırın. Gerçek bir egzersiz değildir; zihinsel prova amaçlıdır.' };
  }
  if (t.toLowerCase().includes('urgency begins')) {
    return { title: 'Sıkışma Başlıyor — Ne Yapmalısınız?', text: 'Senaryo devam ediyor. Ani sıkışma hissi geldi. Öğrendiğiniz adımları sırayla uygulayın: Durun, güvenli kalın, bedeninizi gevşetin, dikkatinizi yönlendirin.' };
  }
  // M5 internal screens
  if (t.includes('M5 giriş') || t.includes('giriş kontrolü')) {
    return { title: 'Gerçek Yaşam Uygulamasına Başlıyoruz', text: 'Bu modüle başlamadan önce güncel planınızın aktif olduğunu ve size uygun olduğunu doğrulayın. Klinisyeniniz tarafından onaylanmış plan ekranda görünmelidir.' };
  }
  if (t.includes('Aktif plan kartı')) {
    return { title: 'Güncel Başlangıç Planınız', text: 'Bu ekranda doktorunuzun size özel belirlediği başlangıç işeme aralığı görünmektedir. Bu aralık yalnızca doktorunuz tarafından değiştirilebilir. Planınızı kendiniz değiştirmeyin.' };
  }
  if (t.includes('ne yapmak istersiniz') || t.includes('Şimdi ne yapmak')) {
    return { title: 'Bugün Ne Yapmak İstiyorsunuz?', text: 'Aşağıdaki seçeneklerden birini seçerek devam edebilirsiniz. Bir sıkışma olayı kaydedebilir, planınızı inceleyebilir ya da destek isteyebilirsiniz.' };
  }
  if (t.includes('Olay zamanı')) {
    return { title: 'Sıkışma Olay Zamanı', text: 'Bu sıkışma olayı ne zaman yaşandı? Olayı mümkünse gerçek zamanda kaydedin. Sonradan girişlerde tahmini zamanı kullanabilirsiniz.' };
  }
  if (t.includes('Beceriyi uygulayabildiniz mi')) {
    return { title: 'Beceriyi Uygulayabildim mi?', text: 'Bu sıkışma sırasında öğrendiğiniz becerileri kullanabildiniz mi? Kullandıysanız hangi adımı uyguladığınızı belirtin. Kullanamadıysanız neden olmadığını not edin — bu bilgi çok değerlidir.' };
  }
  if (t.includes('Nerede zorlandınız')) {
    return { title: 'Güçlük Yaşadığınız Noktalar', text: 'Beceriyi uygularken en çok nerede zorlandınız? Seçeneklerden birini işaretleyin ya da kısa bir not bırakın. Bu bilgi doktorunuzun planı iyileştirmesine yardımcı olur.' };
  }
  if (t.includes('Kaydı tamamla')) {
    return { title: 'Kaydı Tamamlayın', text: 'Bu sıkışma olayının kaydı tamamlandı. Devam etmek için "Tamamla" butonuna dokunun. Kayıt otomatik olarak kaydedilecektir.' };
  }
  if (t.includes('Özet kaynağı') || t.includes('Review-readiness')) {
    return { title: 'Uygulama Dönemi Özeti', text: 'Gerçek yaşam uygulama döneminiz tamamlandı. Kaydettikleriniz klinisyeninize iletilmek üzere hazırlanıyor. Klinisyeniniz bu bilgileri değerlendirerek planınıza ilişkin kararı paylaşacak.' };
  }
  if (t.includes('Doktor değerlendirmesi bekleni')) {
    return { title: 'Doktorunuz Değerlendiriyor', text: 'Gerçek yaşam uygulama döneminizin kaydı doktorunuza iletildi. Doktorunuz bu bilgileri inceleyerek planınıza ilişkin kararı size bildirecektir. Bu süreçte beklemeler yaşanabilir.' };
  }
  // M6/M7 cycling content
  if (t.includes('Ana planınız ve ek desteğiniz')) {
    return { title: 'Güncel Planınız ve Ek Desteğiniz', text: 'Aşağıda şu anda geçerli olan planınız ve doktorunuzun etkinleştirdiği ek destek gösterilmektedir. Yalnızca bu ekranda görünen güncel planı uygulayın.' };
  }
  if (t.includes('Tam olarak ne yapmanız isteniy')) {
    return { title: 'Bugün Ne Yapmanız Gerekiyor?', text: 'Bu ekranda doktorunuzun planladığı günlük göreviniz görünmektedir. Talimatları dikkatlice okuyun ve uygulamayı tamamladığınızda işaretleyin.' };
  }
  if (t.includes('Bugünkü kayıt')) {
    return { title: 'Bugünkü Kaydınız', text: 'Bugün yaşadığınız sıkışma olaylarını, plan uyumunuzu veya deneyimlerinizi kaydedin. Bu kayıtlar klinik takip için önemlidir.' };
  }
  if (t.includes('Desteği geçici olarak durdurma')) {
    return { title: 'Desteği Geçici Olarak Durdurma', text: 'Ek desteği geçici olarak durdurmak istiyorsanız bu seçeneği işaretleyebilirsiniz. Durdurmadan önce doktorunuzla görüşmeniz önerilir.' };
  }
  if (t.includes('One repeat or support') || t.includes('Completion interpretation')) {
    return { title: 'Uygulama Değerlendirmesi', text: 'Bu bölümde bugünkü uygulamanızı kısa olarak değerlendirin. Planı ne kadar uygulayabildiniz? Güçlük yaşadığınız bir durum oldu mu?' };
  }
  if (t.includes('Reassess urgency') || t.includes('Active plan decision') || t.includes('Exit gate')) {
    return { title: 'Gelişim Değerlendirmesi', text: 'Bu noktada doktorunuz uygulama bilgilerinizi gözden geçirecek. Planınıza devam etme, güncelleme veya yeni bir adım belirleme kararı klinisyeninize aittir.' };
  }
  if (t.includes('Controlled movement')) {
    return { title: 'Kontrollü Hareket', text: 'Sıkışma hissi geçmeye başladığında tuvalete güvenle ve kontrollü hareket edin. Acele etmemeniz, hissin artmasını önleyebilir. Adımlarınızı yavaş ve sakin tutun.' };
  }
  if (t.includes('Privacy / RISK')) {
    return { title: 'Gizlilik ve Güvenlik Bilgisi', text: 'Bu uygulamada paylaştığınız tüm veriler gizlidir. Verileriniz yalnızca klinik ekibinizle paylaşılır, üçüncü taraflara iletilmez. Otomatik tanı, risk skoru veya tedavi önerisi üretilmez.' };
  }
  return null; // no mapping, will use generic
}

function getTaskText(num, subtitle) {
  const texts = {
    1: 'Bugün yaşadığınız ani sıkışma olayını kaydedin. Olayın zamanını, nerede olduğunuzu ve ne hissettiğinizi not edin. Bu kayıt klinik takip için kullanılır.',
    2: 'Uyguladığınız becerinin ne kadar işe yaradığını değerlendirin. Hangi adımı uyguladınız? En çok hangi adım yardımcı oldu?',
    3: 'Bugünkü uygulamada güçlük yaşadığınız bir nokta var mıydı? Bu bilgi doktorunuzun planı iyileştirmesine yardımcı olur.',
    4: 'Plan uyumunuzu değerlendirin. Bugün planı ne kadar uygulayabildiniz? Tüm oturumları tamamlayabildiniz mi?',
    5: 'Bu haftaki uygulamanızın kısa özetini hazırlayın. Kaç olay yaşadınız? Beceriyi kaç kez kullandınız?',
    6: 'Doktorunuza iletmek istediğiniz notları ekleyin. Sormak istediğiniz bir soru varsa buraya yazabilirsiniz.',
    7: 'Teknik bir sorun veya plan dışında bir durum yaşıyorsanız destek talebinde bulunun.',
    8: 'Bugün kendinizi genel olarak nasıl hissediyorsunuz? Enerji, uyku ve ruh hali hakkında kısa bir değerlendirme yapın.',
    9: 'Son birkaç gün içinde belirtilerinizde fark ettiğiniz değişimleri not edin.',
    10: 'Bu haftanın hedefini gözden geçirin. Hedefi karşılayabildiniz mi? Hedefi revize etmeye gerek var mı?',
    11: 'Planın uygulanabilirliğini değerlendirin. Zorlayıcı olan durumları not edin.',
    12: 'Uygulama döneminizin son özeti. Bu süreçte en çok ne işinize yaradı?',
  };
  return texts[num] || `${subtitle || 'Bu görevi'} tamamlayın ve sonuçları kaydedin.`;
}

async function fixAll() {
  const client = await pool.connect();
  try {
    const res = await client.query(`
      SELECT cjs.day_number, cjs.order_in_day,
             cm.id as module_id, cmv.id as version_id,
             cmv.title, cmv.subtitle, cmv.content,
             cmt.code as type_code
      FROM content_journey_steps cjs
      JOIN content_modules cm ON cm.id = cjs.module_id
      JOIN content_module_versions cmv ON cmv.module_id = cm.id
      JOIN content_module_types cmt ON cmt.id = cm.module_type_id
      WHERE cjs.journey_id = $1 AND cjs.day_number BETWEEN 16 AND 90
      ORDER BY cjs.day_number, cjs.order_in_day
    `, [JOURNEY_ID]);

    console.log(`Checking ${res.rows.length} steps (Days 16-90)...`);
    await client.query('BEGIN');

    let fixed = 0;

    for (const row of res.rows) {
      const c = row.content || {};
      const type = row.type_code;
      let needsFix = false;
      let newContent = { ...c };

      if (type === 'html_content') {
        let html = c.html || '';
        const plainText = html.replace(/<[^>]+>/g, '');
        const hasUndef = plainText.includes('undefined') || html === '<p>undefined</p>' || !html.trim();
        const hasNoise = NOISE_RE.some(re => { re.lastIndex=0; return re.test(plainText); });
        const hasMidBreak = /<br>\s*[a-züğışçöA-ZÜĞİŞÇÖ]/.test(html);

        if (hasUndef || hasNoise) {
          needsFix = true;
          const mapped = humanizeTitle(row.title, row.subtitle, row.day_number, type);
          if (mapped) {
            newContent = {
              html: `<p class="key-message"><strong>${mapped.title}</strong></p><p>${mapped.text}</p>`,
              readTime: 2,
              _navikont: c._navikont
            };
            // Update title too if it was an internal ID
            if (mapped.title !== row.title) {
              await client.query('UPDATE content_module_versions SET title=$1 WHERE id=$2', [mapped.title, row.version_id]);
            }
          } else if (hasNoise) {
            // Strip noise, keep remaining text
            const cleaned = stripNoise(plainText);
            const finalText = cleaned.length > 30 ? cleaned : (row.subtitle || row.title || 'İçerik yükleniyor.');
            newContent = {
              html: `<p>${finalText}</p>`,
              readTime: Math.max(1, Math.ceil(finalText.length / 500)),
              _navikont: c._navikont
            };
          } else {
            // Pure undefined with no noise — build from title
            newContent = {
              html: `<p class="key-message"><strong>${row.title}</strong></p><p>${row.subtitle || 'Bu içerik klinik ekibinizin onayladığı program kapsamında yer almaktadır.'}</p>`,
              readTime: 2,
              _navikont: c._navikont
            };
          }
        } else if (hasMidBreak) {
          needsFix = true;
          newContent = { ...c, html: fixBreaks(html) };
        }

      } else if (type === 'video') {
        const desc = c.description || '';
        if (!desc || desc === 'undefined' || desc.length < 15) {
          needsFix = true;
          const mapped = humanizeTitle(row.title, row.subtitle, row.day_number, type);
          newContent = {
            ...c,
            description: mapped ? mapped.text : (row.subtitle || `${row.title} video içeriği.`),
          };
          if (mapped && mapped.title !== row.title) {
            await client.query('UPDATE content_module_versions SET title=$1 WHERE id=$2', [mapped.title, row.version_id]);
          }
        } else {
          const fixedDesc = stripNoise(desc);
          if (fixedDesc !== desc && fixedDesc.length > 10) {
            needsFix = true;
            newContent = { ...c, description: fixedDesc };
          }
        }

      } else if (type === 'task') {
        const inst = c.instructions || '';
        const name = c.taskName || '';
        if (!inst || inst === 'undefined' || !name || name === 'undefined') {
          needsFix = true;
          const mapped = humanizeTitle(row.title, row.subtitle, row.day_number, type);
          newContent = {
            taskName: mapped ? mapped.title : row.title,
            estimatedDuration: c.estimatedDuration || 10,
            instructions: mapped ? mapped.text : (row.subtitle || row.title),
            _navikont: c._navikont
          };
          if (mapped && mapped.title !== row.title) {
            await client.query('UPDATE content_module_versions SET title=$1 WHERE id=$2', [mapped.title, row.version_id]);
          }
        }

      } else if (type === 'quiz') {
        const qs = c.questions || [];
        const hasIssue = qs.length === 0 || qs.some(q => !q.text || q.text === 'undefined' || !q.options || q.options.length < 2);
        if (hasIssue) {
          needsFix = true;
          const nav = c._navikont || {};
          const qText = nav.question_text && nav.question_text !== 'undefined'
            ? nav.question_text
            : `${row.title} konusunda hangisi doğrudur?`;
          newContent = {
            questions: [{
              id: `q_${row.version_id.substring(0, 8)}`,
              text: qText,
              type: 'single_choice',
              options: ['Evet, doğru', 'Hayır, yanlış', 'Emin değilim'],
              correctOptionIndex: 0,
              explanation: nav.correct_feedback || ''
            }],
            _navikont: c._navikont
          };
        }
      }

      if (needsFix) {
        await client.query('UPDATE content_module_versions SET content=$1 WHERE id=$2', [JSON.stringify(newContent), row.version_id]);
        fixed++;
        if (fixed % 20 === 0) process.stdout.write(`  ${fixed} fixed...\n`);
      }
    }

    await client.query('COMMIT');
    console.log(`\n✅ Done! Fixed ${fixed} / ${res.rows.length} steps in Days 16-90`);

    // Final scan
    const check = await client.query(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN cmv.content::text LIKE '%undefined%' THEN 1 ELSE 0 END) as undef_count,
        SUM(CASE WHEN cmv.content::text LIKE '%Sayfa %' THEN 1 ELSE 0 END) as noise_count
      FROM content_journey_steps cjs
      JOIN content_modules cm ON cm.id=cjs.module_id
      JOIN content_module_versions cmv ON cmv.module_id=cm.id
      WHERE cjs.journey_id=$1 AND cjs.day_number BETWEEN 16 AND 90
    `, [JOURNEY_ID]);
    const stat = check.rows[0];
    console.log(`Final check: ${stat.total} steps, undefined: ${stat.undef_count}, noise: ${stat.noise_count}`);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error:', err.message);
  } finally {
    client.release();
    pool.end();
  }
}

fixAll();
