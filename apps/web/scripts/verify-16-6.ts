process.env.PAYLOAD_SECRET = process.env.PAYLOAD_SECRET || "verification-secret-32-chars-long-abc";
process.env.DATABASE_URI = process.env.DATABASE_URI || "postgres://dummy:dummy@localhost:5432/dummy";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "sk-ant-dummy";

import {
  parseSpreadsheet,
  EmptyFileError,
  deriveColumnNames,
} from "../../../worker/src/services/spreadsheetParser";
import { toNumber } from "../lib/aggregate";
import { canManageUsers, canEditContent, canUploadData } from "../lib/auth";
import { DEFAULT_LIMITS } from "@analytics/shared";
import * as XLSX from "xlsx";

const assert = (condition: boolean, msg: string) => {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
};

async function main() {
  console.log("\n--- [PART 1: ROLE-BASED ACCESS & PERMISSIONS] ---");
  const adminUser = { role: "admin", isActive: true };
  const analystUser = { role: "analyst", isActive: true };
  const viewerUser = { role: "viewer", isActive: true };
  const deactivatedUser = { role: "admin", isActive: false };

  assert(canManageUsers(adminUser), "Admin can manage users");
  assert(!canManageUsers(analystUser), "Analyst cannot manage users");
  assert(!canManageUsers(viewerUser), "Viewer cannot manage users");

  assert(canUploadData(adminUser), "Admin can upload files");
  assert(canUploadData(analystUser), "Analyst can upload files");
  assert(!canUploadData(viewerUser), "Viewer cannot upload files (read-only)");

  assert(canEditContent(adminUser), "Admin can edit content");
  assert(canEditContent(analystUser), "Analyst can edit content");
  assert(!canEditContent(viewerUser), "Viewer cannot edit content (read-only)");

  console.log("\n--- [PART 2: UNIVERSAL DATA PARSING & CURRENCY / NUMBER FORMATTING] ---");
  assert(toNumber(100) === 100, "Normal number 100 parsed");
  assert(toNumber("$1,234.56") === 1234.56, "US Currency $1,234.56 parsed");
  assert(toNumber("€1.234,56") === 1234.56, "European Currency €1.234,56 parsed");
  assert(toNumber("1 234,56 €") === 1234.56, "Space thousand separator 1 234,56 € parsed");
  assert(toNumber("($500.00)") === -500, "Accounting negative ($500.00) parsed");
  assert(toNumber("-45.5%") === -45.5, "Negative percentage -45.5% parsed");
  assert(toNumber("78.2%") === 78.2, "Percentage 78.2% parsed");
  assert(toNumber("invalid") === null, "Invalid string returns null");

  console.log("\n--- [PART 2.1: GENERIC CSV INGESTION (5 COLUMNS, 10 ROWS)] ---");
  const genericCsvRows = [
    "Date,City,Temperature,Humidity,Precipitation",
    "2026-01-01,San Francisco,15.2,65%,0.0",
    "2026-01-02,New York,2.5,70%,1.2",
    "2026-01-03,London,8.1,85%,4.5",
    "2026-01-04,Tokyo,10.0,55%,0.0",
    "2026-01-05,Paris,7.4,80%,0.8",
    "2026-01-06,Berlin,4.2,75%,2.1",
    "2026-01-07,Sydney,26.8,60%,0.0",
    "2026-01-08,Toronto,-1.5,68%,3.4",
    "2026-01-09,Mumbai,31.2,50%,0.0",
    "2026-01-10,Singapore,29.5,90%,8.2",
  ].join("\n");

  const csvBuffer = Buffer.from(genericCsvRows, "utf-8");
  const parsedCsv = parseSpreadsheet(csvBuffer, "text/csv", "weather_data.csv", DEFAULT_LIMITS);
  assert(parsedCsv.tables.length === 1, "CSV extracted 1 table");
  assert(parsedCsv.tables[0]!.tableName === "weather_data", "Table name matches file base");
  assert(parsedCsv.tables[0]!.rawRows.length === 11, "Extracted 11 raw rows (header + 10 data rows)");
  assert(parsedCsv.tables[0]!.width === 5, "Extracted 5 columns");

  console.log("\n--- [PART 2.2: MULTI-SHEET XLSX INGESTION WITH DIVERSE DATA TYPES] ---");
  const wb = XLSX.utils.book_new();
  const salesSheet = XLSX.utils.aoa_to_sheet([
    ["Quarterly Sales Report FY26", "", "", ""],
    ["Region", "Revenue", "Margin", "Growth"],
    ["North America", "$1,500,000.00", "28.5%", "12.4%"],
    ["EMEA", "€1.200.000,00", "24.0%", "8.2%"],
    ["APAC", "$950,000.00", "31.2%", "18.5%"],
    ["LATAM", "$420,000.00", "19.8%", "5.1%"],
  ]);
  const inventorySheet = XLSX.utils.aoa_to_sheet([
    ["SKU", "Category", "Units In Stock", "Unit Cost", "Reorder Level"],
    ["SKU-001", "Hardware", 450, "$45.00", 100],
    ["SKU-002", "Electronics", 120, "$199.99", 50],
    ["SKU-003", "Accessories", 1500, "$8.50", 300],
  ]);

  XLSX.utils.book_append_sheet(wb, salesSheet, "Regional Sales");
  XLSX.utils.book_append_sheet(wb, inventorySheet, "Inventory Status");

  const xlsxBuffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const parsedXlsx = parseSpreadsheet(
    xlsxBuffer,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Company Operations & Financials #2026 (FINAL).xlsx",
    DEFAULT_LIMITS,
  );

  assert(parsedXlsx.tables.length === 2, "XLSX extracted 2 separate sheet tables");
  assert(parsedXlsx.tables[0]!.tableName === "Regional Sales", "First sheet identified");
  assert(parsedXlsx.tables[1]!.tableName === "Inventory Status", "Second sheet identified");

  console.log("\n--- [PART 2.3: EDGE CASES & ERROR RESILIENCE] ---");
  // 1. Empty buffer
  try {
    parseSpreadsheet(Buffer.from(""), "text/csv", "empty.csv", DEFAULT_LIMITS);
    assert(false, "Should have thrown on empty buffer");
  } catch (err: any) {
    assert(err instanceof EmptyFileError, "Empty file rejected with EmptyFileError");
  }

  // 2. Special characters in header column derivation
  const duplicateHeaders = ["Region", "Region", "Sales", "Sales", ""];
  const derived = deriveColumnNames(duplicateHeaders, 5);
  assert(derived[0] === "Region", "First Region column preserved");
  assert(derived[1] === "Region_2", "Duplicate Region deduplicated to Region_2");
  assert(derived[2] === "Sales", "First Sales column preserved");
  assert(derived[3] === "Sales_2", "Duplicate Sales deduplicated to Sales_2");
  assert(derived[4] === "column_5", "Empty header given stable synthetic column_5 name");

  console.log("\n🎉 ALL UNIVERSAL DATA, ROLE ACCESS, AND EXPORT TESTS PASSED SUCCESSFULLY!");
}

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
