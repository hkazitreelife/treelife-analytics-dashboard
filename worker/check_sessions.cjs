const { Pool } = require('pg');

async function checkSessions() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URI,
    ssl: { rejectUnauthorized: false }
  });
  const res = await pool.query('SELECT * FROM sessions ORDER BY id DESC LIMIT 10;');
  console.log('SESSIONS:', JSON.stringify(res.rows, null, 2));

  const rels = await pool.query("SELECT * FROM _sessions_v_version_datasets LIMIT 10;").catch(() => ({ rows: 'none' }));
  console.log('RELS:', rels.rows);

  const rels2 = await pool.query("SELECT * FROM sessions_rels LIMIT 10;").catch(() => ({ rows: 'none' }));
  console.log('SESSIONS_RELS:', rels2.rows);

  await pool.end();
}
checkSessions().catch(console.error);
