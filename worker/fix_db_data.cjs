const { Pool } = require('pg');

async function fixExistingConfigsAndDatasets() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URI,
    ssl: { rejectUnauthorized: false }
  });

  const configsRes = await pool.query("SELECT id, config, insights FROM configs;");
  console.log(`Found ${configsRes.rows.length} configs to inspect.`);

  for (const row of configsRes.rows) {
    let cfg = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
    let ins = typeof row.insights === 'string' ? JSON.parse(row.insights) : row.insights;
    let changed = false;

    if (cfg && Array.isArray(cfg.insights)) {
      cfg.insights = cfg.insights.map(item => ({
        ...item,
        metrics: Array.isArray(item.metrics) ? item.metrics : [],
        relatedTables: Array.isArray(item.relatedTables) ? item.relatedTables : []
      }));
      changed = true;
    }

    if (Array.isArray(ins)) {
      ins = ins.map(item => ({
        ...item,
        metrics: Array.isArray(item.metrics) ? item.metrics : [],
        relatedTables: Array.isArray(item.relatedTables) ? item.relatedTables : []
      }));
      changed = true;
    }

    if (changed) {
      await pool.query(
        "UPDATE configs SET config = $1::jsonb, insights = $2::jsonb WHERE id = $3",
        [JSON.stringify(cfg), JSON.stringify(ins), row.id]
      );
      console.log(`Updated Config ${row.id}`);
    }
  }

  const dsRes = await pool.query("SELECT id, data FROM datasets;");
  console.log(`Found ${dsRes.rows.length} datasets to normalize.`);
  for (const row of dsRes.rows) {
    let d = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    if (d && Array.isArray(d.tables)) {
      const normalizedTables = d.tables.map(t => {
        const tableName = t.tableName || t.name || "Data";
        const tableRole = t.tableRole || "dimension";
        const rawCols = Array.isArray(t.columns) ? t.columns : [];
        const columns = rawCols.map(c =>
          typeof c === "string"
            ? { name: c, inferredType: "string" }
            : { name: c?.name || "col", inferredType: c?.inferredType || "string" }
        );
        const rows = Array.isArray(t.rows) ? t.rows : [];
        return { tableName, tableRole, columns, rows };
      });

      await pool.query(
        "UPDATE datasets SET data = $1::jsonb WHERE id = $2",
        [JSON.stringify({ tables: normalizedTables }), row.id]
      );
      console.log(`Updated Dataset ${row.id}`);
    }
  }

  console.log("All existing database configs and datasets normalized successfully!");
  await pool.end();
}

fixExistingConfigsAndDatasets().catch(console.error);
