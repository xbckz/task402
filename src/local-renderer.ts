import { chromium } from "playwright";
import { documentHtml } from "./markdown.js";
import type { PdfInput, PdfRenderer } from "./types.js";

const headerTemplate = `<div style="width:100%; padding:0 20mm; font:8px Arial,sans-serif; color:#65727b;"><span class="title"></span></div>`;
const footerTemplate = `<div style="width:100%; padding:0 20mm; font:8px Arial,sans-serif; color:#65727b; display:flex; justify-content:space-between; border-top:1px solid #d5dfe0;"><span>Generated document</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;

export class ChromiumPdfRenderer implements PdfRenderer {
  constructor(private readonly executablePath = process.env.BROWSER_EXECUTABLE_PATH) {}

  async render(input: PdfInput, signal?: AbortSignal): Promise<Uint8Array> {
    if (signal?.aborted) throw signal.reason ?? new Error("PDF rendering was cancelled");
    const browser = await chromium.launch({
      headless: true,
      ...(this.executablePath ? { executablePath: this.executablePath } : {}),
      args: ["--disable-background-networking", "--disable-component-update", "--disable-sync"],
    });
    const abort = () => { void browser.close(); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block" });
      const page = await context.newPage();
      page.setDefaultNavigationTimeout(30_000);
      await page.setContent(documentHtml(input), { waitUntil: "load", timeout: 30_000 });
      const pdf = await page.pdf({
        format: "A4",
        preferCSSPageSize: true,
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate,
        footerTemplate,
        margin: { top: "24mm", right: "20mm", bottom: "22mm", left: "20mm" },
      });
      if (signal?.aborted) throw signal.reason ?? new Error("PDF rendering was cancelled");
      await context.close();
      return new Uint8Array(pdf);
    } finally {
      signal?.removeEventListener("abort", abort);
      await browser.close();
    }
  }
}
