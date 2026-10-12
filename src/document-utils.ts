export function sanitizeFilename(value: string | null | undefined): string {
  const name = (value ?? "document.pdf").replace(/[\\/\0<>:"|?*\x00-\x1f]/g, "_").replace(/\.+$/g, "").trim();
  return (name || "document.pdf").slice(0, 120);
}
