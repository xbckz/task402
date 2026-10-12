import MarkdownIt from "markdown-it";
import sanitizeHtml from "sanitize-html";
import type { PdfInput } from "./types.js";

const markdown = new MarkdownIt("default", {
  html: false,
  linkify: false,
  typographer: true,
  breaks: false,
});

const allowedTags = [
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "li", "blockquote",
  "code", "pre", "strong", "em", "del", "table", "thead", "tbody", "tr", "th", "td", "hr", "br", "a",
];

const css = `
  @page { size: A4; margin: 23mm 20mm 23mm; }
  * { box-sizing: border-box; }
  html { color: #202b35; background: #fff; }
  body { margin: 0; font: 10.5pt/1.58 "Segoe UI", "Noto Sans", Arial, sans-serif; overflow-wrap: anywhere; }
  main { width: 100%; min-width: 0; }
  h1, h2, h3, h4 { color: #142b3b; line-height: 1.24; break-after: avoid; }
  h1 { font-size: 26pt; margin: 0 0 18pt; padding-bottom: 11pt; border-bottom: 2px solid #167a7d; overflow-wrap: anywhere; }
  h2 { font-size: 17pt; margin: 22pt 0 9pt; }
  h3 { font-size: 13pt; margin: 17pt 0 7pt; }
  h4 { font-size: 11pt; margin: 14pt 0 6pt; }
  p { margin: 0 0 9pt; orphans: 3; widows: 3; }
  ul, ol { margin: 0 0 11pt; padding-left: 21pt; }
  li { margin: 0 0 4pt; }
  blockquote { margin: 11pt 0; padding: 2pt 12pt; border-left: 3px solid #8cb9b7; color: #536471; }
  code { font-family: Consolas, "Liberation Mono", monospace; font-size: 9pt; background: #f1f4f5; padding: 1pt 3pt; border-radius: 2pt; overflow-wrap: anywhere; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; padding: 10pt; background: #f1f4f5; border: 1px solid #dfe6e8; border-radius: 4pt; break-inside: avoid; }
  pre code { padding: 0; background: transparent; }
  table { width: 100%; max-width: 100%; table-layout: fixed; border-collapse: collapse; margin: 12pt 0 16pt; font-size: 9.25pt; break-inside: auto; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
  th { background: #e9f1f1; color: #163a46; text-align: left; font-weight: 700; }
  th, td { border: 1px solid #cbd6d9; padding: 6pt 7pt; vertical-align: top; overflow-wrap: anywhere; word-break: normal; }
  a { color: #126d77; text-decoration: underline; overflow-wrap: anywhere; }
  hr { border: 0; border-top: 1px solid #d5dfe0; margin: 18pt 0; }
`;

export function documentHtml(input: PdfInput): string {
  const rendered = markdown.render(input.markdown);
  const safe = sanitizeHtml(rendered, {
    allowedTags,
  allowedAttributes: { a: ["href", "title"], th: ["style"], td: ["style"] },
  allowedStyles: {
    th: { "text-align": [/^(left|right|center)$/] },
    td: { "text-align": [/^(left|right|center)$/] },
  },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesAppliedToAttributes: ["href"],
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    parser: { lowerCaseTags: true },
  });

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; script-src 'none'; connect-src 'none';">
  <title>${escapeHtml(input.title)}</title>
  <style>${css}</style>
</head>
<body><main><h1>${escapeHtml(input.title)}</h1>${safe}</main></body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}
