import { documentHtml } from "./markdown.js";
import type { PdfInput, PdfRenderer } from "./types.js";

export interface BrowserRunBinding {
  quickAction(action: "pdf", options: Record<string, unknown>): Promise<Response>;
}

const headerTemplate = `<div style="width:100%; padding:0 20mm; font:8px Arial,sans-serif; color:#65727b;"><span class="title"></span></div>`;
const footerTemplate = `<div style="width:100%; padding:0 20mm; font:8px Arial,sans-serif; color:#65727b; display:flex; justify-content:space-between; border-top:1px solid #d5dfe0;"><span>Generated document</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;

export class CloudflareBrowserRunRenderer implements PdfRenderer {
  constructor(private readonly browser: BrowserRunBinding) {}

  async render(input: PdfInput, signal?: AbortSignal): Promise<Uint8Array> {
    if (signal?.aborted) throw signal.reason ?? new Error("PDF rendering was cancelled");
    const response = await this.browser.quickAction("pdf", {
      html: documentHtml(input),
      rejectResourceTypes: ["image", "font", "media", "script", "stylesheet"],
      rejectRequestPattern: ["/^https?:\\/\\//i"],
      pdfOptions: {
        format: "a4",
        landscape: false,
        printBackground: true,
        preferCSSPageSize: true,
        displayHeaderFooter: true,
        headerTemplate,
        footerTemplate,
        margin: { top: "24mm", right: "20mm", bottom: "22mm", left: "20mm" },
        timeout: 45_000,
      },
    });
    if (!response.ok) throw new Error(`Browser Run PDF action failed with HTTP ${response.status}`);
    if (signal?.aborted) throw signal.reason ?? new Error("PDF rendering was cancelled");
    return new Uint8Array(await response.arrayBuffer());
  }
}
