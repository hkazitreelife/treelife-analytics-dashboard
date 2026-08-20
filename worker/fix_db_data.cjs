const { Pool } = require('pg');

function inferType(values) {
  const nonNull = values.filter(v => v !== null && v !== undefined && String(v).trim() !== '');
  if (nonNull.length === 0) return 'text';

  let numCount = 0;
  let dateCount = 0;
  let boolCount = 0;

  for (const v of nonNull) {
    if (typeof v === 'boolean' || v === 'true' || v === 'false') {
      boolCount++;
      continue;
    }
    if (typeof v === 'number' && !isNaN(v)) {
      numCount++;
      continue;
    }
    if (typeof v === 'string') {
      const clean = v.replace(/[$€£¥₹\s,%]/g, '').replace(/\((.*)\)/, '-$1');
      if (clean.length > 0 && !isNaN(Number(clean))) {
        numCount++;
        continue;
      }
      if (!/^\d+$/.test(v) && !isNaN(Date.parse(v)) && v.length > 5 && (v.includes('-') || v.includes('/'))) {
        dateCount++;
        continue;
      }
    }
  }

  const thresh = nonNull.length * 0.5;
  if (numCount >= thresh) return 'numeric';
  if (boolCount >= thresh) return 'boolean';
  if (dateCount >= thresh) return 'date';

  const unique = new Set(nonNull.map(v => String(v).trim()));
  if (unique.size <= 25 || unique.size < nonNull.length * 0.4) return 'categorical';

  return 'text';
}

async function fixExistingConfigsAndDatasets() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URI,
    ssl: { rejectUnauthorized: false }
  });

  const dsRes = await pool.query("SELECT id, data FROM datasets;");
  console.log(`Found ${dsRes.rows.length} datasets to normalize.`);
  for (const row of dsRes.rows) {
    let d = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    if (d && Array.isArray(d.tables)) {
      const normalizedTables = d.tables.map(t => {
        const tableName = t.tableName || t.name || "Data";
        const tableRole = t.tableRole || "dimension";
        const rows = Array.isArray(t.rows) ? t.rows : [];
        const rawCols = Array.isArray(t.columns) ? t.columns : [];
        const columns = rawCols.map(c => {
          const name = typeof c === 'string' ? c : (c?.name || 'col');
          const sampleVals = rows.slice(0, 100).map(r => r[name]);
          const inferredType = inferType(sampleVals);
          return { name, inferredType };
        });
        return { tableName, tableRole, columns, rows };
      });

      await pool.query(
        "UPDATE datasets SET data = $1::jsonb WHERE id = $2",
        [JSON.stringify({ tables: normalizedTables }), row.id]
      );
      console.log(`Updated Dataset ${row.id} with inferred column types.`);
    }
  }

  console.log("All existing database datasets normalized with true numeric inferred types!");
  await pool.end();
}

fixExistingConfigsAndDatasets().catch(console.error);
