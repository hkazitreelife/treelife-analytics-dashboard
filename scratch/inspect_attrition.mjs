import * as XLSX from 'xlsx';
import path from 'path';

const file = path.resolve('apps/web/media/Copy of Copy of Treelife Attrition Report FY2526.xlsx');
const wb = XLSX.readFile(file);
console.log('SHEET NAMES:', wb.SheetNames);
for (const s of wb.SheetNames) {
  const ws = wb.Sheets[s];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
  console.log('\n--- SHEET:', s, '--- (total rows:', rows.length, ')');
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    console.log('Row', i, ':', rows[i]);
  }
}
