/**
 * Universal Artifact Export Utility: CSV, PNG (300 DPI), SVG, and Print-Ready PDF.
 */

/**
 * Exports raw tabular data rows to a well-formed CSV file with UTF-8 BOM encoding.
 */
export const exportRowsToCsv = (
  filename: string,
  rows: Record<string, unknown>[],
  columns?: string[],
): void => {
  if (!rows || rows.length === 0) {
    alert("No rows available to export.");
    return;
  }

  const columnNames = columns && columns.length > 0
    ? columns
    : Object.keys(rows[0] ?? {});

  const escapeCsvCell = (val: unknown): string => {
    if (val === null || val === undefined) return "";
    const str = typeof val === "object" ? JSON.stringify(val) : String(val);
    if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const headerRow = columnNames.map(escapeCsvCell).join(",");
  const dataRows = rows.map((row) =>
    columnNames.map((col) => escapeCsvCell(row[col])).join(","),
  );

  const csvContent = "\uFEFF" + [headerRow, ...dataRows].join("\r\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

/**
 * Prepares a self-contained SVG clone with all computed styles, colors, fonts, and dimensions inlined.
 * This guarantees that when serialized to a standalone .svg or rasterized on a <canvas> for PNG,
 * all bars, lines, axes, and legends remain 100% visible and crisp without relying on external stylesheets.
 */
const prepareStandaloneSvg = (svgElement: SVGSVGElement): SVGSVGElement => {
  const clone = svgElement.cloneNode(true) as SVGSVGElement;
  const originalElements = [svgElement, ...Array.from(svgElement.querySelectorAll("*"))];
  const clonedElements = [clone, ...Array.from(clone.querySelectorAll("*"))];

  for (let i = 0; i < originalElements.length; i++) {
    const orig = originalElements[i] as Element;
    const cloned = clonedElements[i] as HTMLElement | SVGElement;
    if (!orig || !cloned) continue;

    const computed = window.getComputedStyle(orig);

    // Explicitly set fill (critical for SVG: default fill is black if unspecified)
    if (!computed.fill || computed.fill === "none" || computed.fill === "rgba(0, 0, 0, 0)") {
      cloned.setAttribute("fill", "none");
    } else {
      cloned.setAttribute("fill", computed.fill);
    }

    // Explicitly set stroke
    if (computed.stroke && computed.stroke !== "none" && computed.stroke !== "rgba(0, 0, 0, 0)") {
      cloned.setAttribute("stroke", computed.stroke);
      cloned.setAttribute("stroke-width", computed.strokeWidth || "1");
      if (computed.strokeDasharray && computed.strokeDasharray !== "none") {
        cloned.setAttribute("stroke-dasharray", computed.strokeDasharray);
      }
    } else {
      cloned.setAttribute("stroke", "none");
    }

    if (computed.opacity) {
      cloned.setAttribute("opacity", computed.opacity);
    }
    if (computed.fontFamily) {
      cloned.setAttribute("font-family", computed.fontFamily);
    }
    if (computed.fontSize) {
      cloned.setAttribute("font-size", computed.fontSize);
    }
    if (computed.fontWeight) {
      cloned.setAttribute("font-weight", computed.fontWeight);
    }
    if (computed.color) {
      cloned.setAttribute("color", computed.color);
    }
  }

  const bbox = svgElement.getBoundingClientRect();
  const width = Math.max(
    Math.round(bbox.width || svgElement.clientWidth || svgElement.parentElement?.clientWidth || 600),
    320,
  );
  const height = Math.max(
    Math.round(bbox.height || svgElement.clientHeight || svgElement.parentElement?.clientHeight || 240),
    220,
  );

  clone.setAttribute("width", "100%");
  clone.setAttribute("height", String(height));
  clone.setAttribute("viewBox", `0 0 ${width} ${height}`);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.style.width = "100%";
  clone.style.height = `${height}px`;
  clone.style.display = "block";
  clone.style.overflow = "visible";
  clone.style.backgroundColor = "#ffffff";

  return clone;
};

/**
 * Exports an SVG chart from the DOM as a standalone vector .svg file.
 */
export const exportWidgetToSvg = (
  containerElement: HTMLElement,
  filename: string,
): void => {
  const svgElement = containerElement.querySelector("svg");

  if (!svgElement) {
    alert("No chart vector graphic found in this widget.");
    return;
  }

  const preparedSvg = prepareStandaloneSvg(svgElement);
  const serializer = new XMLSerializer();
  const svgString = serializer.serializeToString(preparedSvg);

  const blob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = filename.endsWith(".svg") ? filename : `${filename}.svg`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

/**
 * Exports an SVG chart from the DOM as a crisp, high-resolution (300 DPI) PNG.
 */
export const exportWidgetToPng = (
  containerElement: HTMLElement,
  filename: string,
  scale = 3,
): void => {
  const svgElement = containerElement.querySelector("svg");

  if (!svgElement) {
    alert("No chart graphic found in this widget.");
    return;
  }

  const preparedSvg = prepareStandaloneSvg(svgElement);
  const width = parseInt(preparedSvg.getAttribute("width") || "600", 10);
  const height = parseInt(preparedSvg.getAttribute("height") || "400", 10);

  const serializer = new XMLSerializer();
  const svgString = serializer.serializeToString(preparedSvg);

  const svgBlob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
  const URLObj = window.URL || window.webkitURL || window;
  const blobURL = URLObj.createObjectURL(svgBlob);

  const image = new Image();
  image.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;

    const context = canvas.getContext("2d");
    if (!context) {
      URLObj.revokeObjectURL(blobURL);
      return;
    }

    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    canvas.toBlob((pngBlob) => {
      URLObj.revokeObjectURL(blobURL);
      if (!pngBlob) return;

      const pngUrl = URLObj.createObjectURL(pngBlob);
      const link = document.createElement("a");
      link.href = pngUrl;
      link.download = filename.endsWith(".png") ? filename : `${filename}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URLObj.revokeObjectURL(pngUrl);
    }, "image/png");
  };

  image.src = blobURL;
};

/**
 * Converts an SVG element into a high-res PNG base64 Data URL for presentation embedding.
 */
const svgToPngDataUrl = async (svgElement: SVGSVGElement): Promise<string> => {
  return new Promise((resolve) => {
    try {
      const preparedSvg = prepareStandaloneSvg(svgElement);
      const width = parseInt(preparedSvg.getAttribute("width") || "800", 10);
      const height = parseInt(preparedSvg.getAttribute("height") || "450", 10);
      const svgString = new XMLSerializer().serializeToString(preparedSvg);
      const blob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
      const blobUrl = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = width * 2;
        canvas.height = height * 2;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          URL.revokeObjectURL(blobUrl);
          resolve("");
          return;
        }
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(blobUrl);
        resolve(canvas.toDataURL("image/png"));
      };
      img.onerror = () => {
        URL.revokeObjectURL(blobUrl);
        resolve("");
      };
      img.src = blobUrl;
    } catch {
      resolve("");
    }
  });
};

/**
 * Exports the entire dashboard into a structured PowerPoint (.pptx) presentation.
 * Groups KPIs and pairs charts into a clean, concise executive presentation deck (typically 3-6 slides)
 * rather than generating individual slides for every single widget.
 */
export const exportDashboardToPptx = async ({
  title,
  datasetName,
}: {
  title: string;
  datasetName?: string;
}): Promise<void> => {
  const pptxModule = await import("pptxgenjs");
  const PptxGenJS = (pptxModule.default || pptxModule) as unknown as typeof import("pptxgenjs").default;
  const pptx = new (PptxGenJS as any)();
  pptx.layout = "LAYOUT_16x9";
  pptx.author = "Analytics Dashboard";
  pptx.company = "Executive Reporting";
  pptx.title = title;

  // 1. Title Cover Slide
  const titleSlide = pptx.addSlide();
  titleSlide.background = { color: "0D3B26" }; // Brand forest
  titleSlide.addText(title, {
    x: 0.8,
    y: 1.8,
    w: 8.4,
    h: 1.4,
    fontSize: 32,
    bold: true,
    color: "FFFFFF",
  });
  titleSlide.addText(`Dataset: ${datasetName || "Analytics Workspace"} · Exported ${new Date().toLocaleDateString()}`, {
    x: 0.8,
    y: 3.3,
    w: 8.4,
    h: 0.4,
    fontSize: 14,
    color: "C8F04D",
  });
  titleSlide.addText("Executive Performance & Data Intelligence Deck", {
    x: 0.8,
    y: 3.9,
    w: 8.4,
    h: 0.4,
    fontSize: 12,
    color: "94A3B8",
  });

  // 2. Extract widgets from DOM (visible or active tab)
  const allWidgets = Array.from(document.querySelectorAll<HTMLElement>("[data-widget-id]"));
  const visibleWidgets = allWidgets.filter((el) => {
    const closestTab = el.closest("[role='tabpanel']");
    if (closestTab && closestTab.getAttribute("data-state") === "inactive") return false;
    if (closestTab && (closestTab as HTMLElement).style.display === "none") return false;
    return el.offsetParent !== null || el.getBoundingClientRect().height > 0;
  });

  const widgetsToProcess = visibleWidgets.length > 0 ? visibleWidgets : allWidgets.slice(0, 12);

  type KpiEntry = { title: string; value: string; table: string; note: string };
  const kpiItems: KpiEntry[] = [];
  const chartElements: HTMLElement[] = [];

  for (const el of widgetsToProcess) {
    const type = el.getAttribute("data-widget-type");
    const svg = el.querySelector("svg");

    if (type === "kpi_card" || (!svg && !el.querySelector("table"))) {
      const kpiTitle = el.querySelector(".text-xs.font-bold, .uppercase")?.textContent || el.querySelector("h3")?.textContent || "Metric";
      const kpiValue = el.querySelector(".font-mono, .text-3xl, .text-4xl")?.textContent || el.innerText.trim().split("\n")[0] || "";
      const kpiTable = el.querySelector(".rounded-full, .text-\\[10px\\]")?.textContent || "";
      const kpiNote = el.querySelector(".text-\\[11px\\], .border-t")?.textContent || "";
      kpiItems.push({
        title: kpiTitle.trim(),
        value: kpiValue.trim(),
        table: kpiTable.trim(),
        note: kpiNote.trim(),
      });
    } else if (svg || type === "bar" || type === "line" || type === "pie") {
      chartElements.push(el);
    }
  }

  // 3. Executive KPI Summary Slide(s)
  if (kpiItems.length > 0) {
    const chunkSize = 6;
    const totalChunks = Math.ceil(kpiItems.length / chunkSize);

    for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
      const chunk = kpiItems.slice(chunkIdx * chunkSize, (chunkIdx + 1) * chunkSize);
      const kpiSlide = pptx.addSlide();
      kpiSlide.background = { color: "F8FAFC" };
      kpiSlide.addText(
        totalChunks === 1 ? "Executive Summary: Key Performance Indicators" : `Key Performance Indicators (Part ${chunkIdx + 1})`,
        {
          x: 0.6,
          y: 0.4,
          w: 8.8,
          h: 0.5,
          fontSize: 20,
          bold: true,
          color: "0D3B26",
        },
      );

      chunk.forEach((kpi, idx) => {
        const col = idx % 3;
        const row = Math.floor(idx / 3);
        const cardX = 0.6 + col * 2.95;
        const cardY = 1.1 + row * 1.9;
        const cardW = 2.8;
        const cardH = 1.7;

        kpiSlide.addShape(pptx.ShapeType.rect, {
          x: cardX,
          y: cardY,
          w: cardW,
          h: cardH,
          fill: { color: "FFFFFF" },
          line: { color: "E2E8F0", width: 1 },
          radius: 0.08,
        });

        kpiSlide.addText(kpi.title, {
          x: cardX + 0.15,
          y: cardY + 0.15,
          w: cardW - 0.3,
          h: 0.3,
          fontSize: 11,
          bold: true,
          color: "4A5D73",
        });

        kpiSlide.addText(kpi.value, {
          x: cardX + 0.15,
          y: cardY + 0.48,
          w: cardW - 0.3,
          h: 0.6,
          fontSize: 24,
          bold: true,
          color: "0D3B26",
        });

        if (kpi.table || kpi.note) {
          kpiSlide.addText(`${kpi.table ? `[${kpi.table}] ` : ""}${kpi.note}`.slice(0, 45), {
            x: cardX + 0.15,
            y: cardY + 1.22,
            w: cardW - 0.3,
            h: 0.35,
            fontSize: 9,
            color: "64748B",
          });
        }
      });
    }
  }

  // 4. Visualizations / Chart Slides (Paired or single)
  for (let i = 0; i < chartElements.length; i += 2) {
    const chart1 = chartElements[i];
    const chart2 = chartElements[i + 1];

    if (!chart2) {
      const svg = chart1?.querySelector("svg");
      if (!svg) continue;
      const titleText = chart1?.querySelector("h3, [class*='CardTitle'], .text-xs.font-bold")?.textContent || "Visual Analytics";

      const slide = pptx.addSlide();
      slide.background = { color: "F8FAFC" };
      slide.addText(titleText.trim(), {
        x: 0.6,
        y: 0.4,
        w: 8.8,
        h: 0.5,
        fontSize: 18,
        bold: true,
        color: "0D3B26",
      });

      const pngData = await svgToPngDataUrl(svg as SVGSVGElement);
      if (pngData) {
        slide.addImage({
          data: pngData,
          x: 0.6,
          y: 1.05,
          w: 8.8,
          h: 4.15,
        });
      }
    } else {
      const svg1 = chart1?.querySelector("svg");
      const svg2 = chart2?.querySelector("svg");
      const title1 = chart1?.querySelector("h3, [class*='CardTitle'], .text-xs.font-bold")?.textContent || "Visualization 1";
      const title2 = chart2?.querySelector("h3, [class*='CardTitle'], .text-xs.font-bold")?.textContent || "Visualization 2";

      const slide = pptx.addSlide();
      slide.background = { color: "F8FAFC" };
      slide.addText("Visual Analytics & Trends", {
        x: 0.6,
        y: 0.35,
        w: 8.8,
        h: 0.4,
        fontSize: 18,
        bold: true,
        color: "0D3B26",
      });

      if (svg1) {
        slide.addText(title1.trim(), {
          x: 0.6,
          y: 0.85,
          w: 4.3,
          h: 0.3,
          fontSize: 11,
          bold: true,
          color: "1C2B3A",
        });
        const png1 = await svgToPngDataUrl(svg1 as SVGSVGElement);
        if (png1) {
          slide.addImage({ data: png1, x: 0.6, y: 1.2, w: 4.3, h: 3.9 });
        }
      }

      if (svg2) {
        slide.addText(title2.trim(), {
          x: 5.1,
          y: 0.85,
          w: 4.3,
          h: 0.3,
          fontSize: 11,
          bold: true,
          color: "1C2B3A",
        });
        const png2 = await svgToPngDataUrl(svg2 as SVGSVGElement);
        if (png2) {
          slide.addImage({ data: png2, x: 5.1, y: 1.2, w: 4.3, h: 3.9 });
        }
      }
    }
  }

  await pptx.writeFile({
    fileName: `${(title || "dashboard").toLowerCase().replace(/[^a-z0-9]/g, "_")}.pptx`,
  });
};

const escapeHtml = (str: string): string => {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
};

/**
 * Exports the ENTIRE dashboard into a standalone, pixel-perfect HTML snapshot.
 * Clones the full live DOM tree (cards, 12-col grid, header, tabs, metrics, tables, AI insights)
 * with all CSS styles, Tailwind utility rules, CSS variables, and vector SVG charts inlined.
 */
export const exportDashboardToHtml = async ({
  title,
  datasetName,
}: {
  title: string;
  datasetName?: string;
}): Promise<void> => {
  // 1. Locate the main dashboard container
  const mainElement =
    document.querySelector<HTMLElement>("main") ||
    document.querySelector<HTMLElement>(".dashboard-root") ||
    document.body;

  // 2. Clone the dashboard DOM
  const clone = mainElement.cloneNode(true) as HTMLElement;

  // 3. Process every live widget by ID to guarantee 100% accurate chart replacement
  const origWidgets = Array.from(mainElement.querySelectorAll<HTMLElement>("[data-widget-id]"));

  for (const origWidget of origWidgets) {
    const widgetId = origWidget.getAttribute("data-widget-id");
    if (!widgetId) continue;

    const clonedWidget = clone.querySelector<HTMLElement>(`[data-widget-id="${widgetId}"]`);
    if (!clonedWidget) continue;

    const origSvg = origWidget.querySelector("svg");
    if (origSvg) {
      const widgetTitle =
        origWidget.querySelector("h3, [class*='CardTitle'], .text-xs.font-bold")?.textContent ||
        "Data Chart";

      const pngDataUrl = await svgToPngDataUrl(origSvg as SVGSVGElement);
      const standaloneSvg = prepareStandaloneSvg(origSvg as SVGSVGElement);

      const chartHost =
        clonedWidget.querySelector(".recharts-responsive-container") ||
        clonedWidget.querySelector(".recharts-wrapper") ||
        clonedWidget.querySelector("svg")?.parentElement;

      if (chartHost) {
        if (pngDataUrl) {
          chartHost.innerHTML = `
            <div style="width: 100%; height: 260px; display: flex; align-items: center; justify-content: center; background: #ffffff; padding: 4px; border-radius: 8px;">
              <img src="${pngDataUrl}" alt="${escapeHtml(widgetTitle.trim())}" style="max-width: 100%; max-height: 100%; width: 100%; height: auto; object-fit: contain; display: block;" />
            </div>
          `;
        } else {
          chartHost.innerHTML = "";
          chartHost.appendChild(standaloneSvg);
        }
      }
    }
  }

  // 4. Remove non-printable toolbar buttons (e.g. export dropdown, assistant drawer button)
  clone.querySelectorAll(".no-print").forEach((el) => el.remove());
  clone.querySelectorAll("button").forEach((btn) => {
    const text = btn.textContent || "";
    if (
      text.includes("Export") ||
      text.includes("Assistant") ||
      text.includes("+ New") ||
      text.includes("Admin") ||
      text.includes("Edit")
    ) {
      btn.remove();
    }
  });

  // 5. Ensure all card containers in the clone have visible dimensions and no scroll cutoffs
  clone.querySelectorAll<HTMLElement>(".overflow-y-auto, .overflow-auto").forEach((el) => {
    el.style.overflow = "visible";
    el.style.maxHeight = "none";
  });

  // 6. Gather all compiled CSS rules from document.styleSheets
  let collectedStyles = "";
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const rules = Array.from(sheet.cssRules || []);
      for (const rule of rules) {
        collectedStyles += rule.cssText + "\n";
      }
    } catch {
      // Cross-origin stylesheet access might throw in some browsers; ignore
    }
  }

  // Fallback CSS variables in case sheets were external
  const rootVariables = `
    :root {
      --color-forest: #0d3b26;
      --color-forest-surface: #e8f5e9;
      --color-forest-bright: #2e8b57;
      --color-forest-mid: #1a5c3a;
      --color-forest-dark: #072316;
      --color-ink: #0f172a;
      --color-steel: #475569;
      --color-steel-light: #94a3b8;
      --color-cloud: #e2e8f0;
      --color-cloud-light: #f8fafc;
      --color-warm-white: #fdfbf7;
    }
    * {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: #fdfbf7;
      color: #0f172a;
      margin: 0;
      padding: 24px;
    }
    .report-shell {
      max-width: 1540px;
      margin: 0 auto;
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 16px;
      padding: 32px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.04);
    }
    .export-top-banner {
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: #0d3b26;
      color: #ffffff;
      padding: 14px 24px;
      border-radius: 12px;
      margin-bottom: 28px;
      font-size: 13px;
      font-weight: 600;
    }
    .export-top-banner button {
      background: #c8f04d;
      color: #0d3b26;
      border: none;
      font-weight: 800;
      padding: 8px 16px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 12px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: opacity 0.2s;
    }
    .export-top-banner button:hover {
      opacity: 0.9;
    }
    .recharts-responsive-container, .recharts-wrapper {
      width: 100% !important;
      height: 240px !important;
      min-height: 240px !important;
      display: block !important;
      visibility: visible !important;
    }
    .recharts-surface {
      width: 100% !important;
      height: 240px !important;
      min-height: 240px !important;
      overflow: visible !important;
      visibility: visible !important;
    }
    svg {
      max-width: 100% !important;
      overflow: visible !important;
      visibility: visible !important;
    }
    .recharts-bar-rectangle path,
    .recharts-bar-rectangles path,
    .recharts-bar-rectangles rect,
    .recharts-pie-sector path,
    .recharts-line-curve path,
    .recharts-curve path,
    .recharts-cartesian-grid line {
      opacity: 1 !important;
      visibility: visible !important;
    }
    @media print {
      body {
        background: #ffffff !important;
        padding: 0 !important;
      }
      .report-shell {
        border: none !important;
        box-shadow: none !important;
        padding: 0 !important;
        max-width: 100% !important;
      }
      .export-top-banner, .no-print {
        display: none !important;
      }
      .group, [data-widget-id] {
        break-inside: avoid !important;
        page-break-inside: avoid !important;
        margin-bottom: 16px !important;
      }
    }
  `;

  const htmlDoc = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · Dashboard Export</title>
  <style>
    ${rootVariables}
    ${collectedStyles}
  </style>
</head>
<body>
  <div class="report-shell">
    <div class="export-top-banner no-print">
      <div>
        <span>📊 Standalone Dashboard Snapshot · ${escapeHtml(datasetName || "Analytics Workspace")}</span>
        <span style="opacity: 0.8; font-size: 11px; margin-left: 8px;">Exported ${new Date().toLocaleString()}</span>
      </div>
      <button onclick="window.print()">
        <span>🖨️</span>
        <span>Print to PDF</span>
      </button>
    </div>

    ${clone.innerHTML}
  </div>

  <script>
    // Enable client-side tab switching in standalone HTML export
    document.querySelectorAll('[role="tab"]').forEach(function(trigger) {
      trigger.addEventListener('click', function() {
        var tabVal = trigger.getAttribute('data-value') || trigger.getAttribute('value');
        var container = trigger.closest('.report-shell') || document;
        container.querySelectorAll('[role="tab"]').forEach(function(t) {
          var isCurrent = (t === trigger);
          t.setAttribute('data-state', isCurrent ? 'active' : 'inactive');
          if (isCurrent) {
            t.classList.add('bg-white', 'shadow-xs', 'text-[color:var(--color-forest)]');
          } else {
            t.classList.remove('bg-white', 'shadow-xs');
          }
        });
        container.querySelectorAll('[role="tabpanel"]').forEach(function(panel) {
          var panelVal = panel.getAttribute('data-value') || panel.getAttribute('value');
          var isActive = (panelVal === tabVal);
          panel.setAttribute('data-state', isActive ? 'active' : 'inactive');
          panel.style.display = isActive ? 'block' : 'none';
        });
      });
    });
  </script>
</body>
</html>`;

  const blob = new Blob([htmlDoc], { type: "text/html;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${(title || "dashboard").toLowerCase().replace(/[^a-z0-9]/g, "_")}-full-dashboard.html`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

/**
 * Triggers the browser's native print-to-PDF engine with custom print layout.
 */
export const triggerPrintReport = (): void => {
  setTimeout(() => {
    window.print();
  }, 100);
};
