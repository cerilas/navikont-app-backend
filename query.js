const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://postgres:sKCBeqpAXLrEjZXwRoezFtDRYQLIsvPb@acela.proxy.rlwy.net:42498/railway' });
pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'forms_questions'", (err, res) => {
  console.log('forms_questions columns:', res?.rows.map(r => r.column_name));
  pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'forms_question_options'", (err, res) => {
    console.log('forms_question_options columns:', res?.rows.map(r => r.column_name));
    process.exit();
  });
});
