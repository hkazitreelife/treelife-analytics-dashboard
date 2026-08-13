export type JobStatus =
  | "queued"
  | "processing"
  | "validating"
  | "generating_config"
  | "completed"
  | "failed"
  | "duplicate_noop";

export type DatasetStatus =
  | "processing"
  | "ready"
  | "failed"
  | "updating";

export type SupportedFileType =
  | "xlsx"
  | "csv"
  | "pdf"
  | "image"
  | "pptx"
  // Section 10.0: recognized at upload, routed to the narrative document
  // pipeline (worker/src/processors/documentIngestion.ts), never the
  // Section 14 table pipeline.
  | "docx";

export type InferredColumnType =
  | "numeric"
  | "categorical"
  | "date"
  | "id"
  | "text"
  | "boolean";

export type TableRole =
  | "data"
  | "documentation"
  | "config"
  | "unknown";

export interface SourceFileMetadata {
  name: string;
  type: SupportedFileType;
  hash: string;
}

export interface NormalizedColumn {
  name: string;
  inferredType: InferredColumnType;
  nullable: boolean;
  sampleValues: string[];
}

export interface NormalizedTable {
  tableName: string;
  tableRole: TableRole;
  columns: NormalizedColumn[];
  rows: Record<string, unknown>[];
  rowHash: string;
}

export interface NormalizedRelationship {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  confidence: number;
}

export interface NormalizedDataset {
  datasetId: string;
  sourceFile: SourceFileMetadata;
  tables: NormalizedTable[];
  relationships: NormalizedRelationship[];
}

export type WidgetType =
  | "kpi_card"
  | "bar"
  | "line"
  | "pie"
  | "table";

export type AggregationType =
  | "none"
  | "sum"
  | "count"
  | "avg";

export interface WidgetPosition {
  row: number;
  col: number;
  w: number;
  h: number;
}

export interface DashboardWidget {
  widgetId: string;
  type: WidgetType;
  title: string;
  sourceTable: string;
  fields: string[];
  aggregation: AggregationType;
  position: WidgetPosition;
}

export interface DashboardTab {
  tabId: string;
  tabName: string;
  widgets: DashboardWidget[];
}

export type InsightSeverity =
  | "info"
  | "warning"
  | "positive"
  | "negative";

export interface DashboardInsight {
  insightId: string;
  title: string;
  body: string;
  severity: InsightSeverity;
  relatedTables: string[];
}

export interface DashboardConfig {
  datasetId: string;
  title: string;
  tabs: DashboardTab[];
  insights: DashboardInsight[];
}
