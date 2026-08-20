const { Pool } = require('pg');

async function checkCols() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URI,
    ssl: { rejectUnauthorized: false }
  });
  const res = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'files'");
  console.log('COLUMNS IN FILES TABLE:', res.rows.map(r => `${r.column_name} (${r.data_type})`));
  await pool.end();
}
checkCols().catch(console.error);
