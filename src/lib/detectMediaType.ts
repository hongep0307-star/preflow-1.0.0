/**
 * Detect the media type of a base64-encoded image.
 *
 * - If the string is a full data URL (`data:image/...;base64,...`), extract the type from the prefix.
 * - Otherwise, inspect the first few characters of the raw base64 to guess the format.
 */
export function detectMediaType(base64: string): string {
  // Handle data URL prefix
  const dataUrlMatch = base64.match(/^data:(image\/[a-zA-Z+]+);base64,/);
  if (dataUrlMatch) return dataUrlMatch[1];

  // Inspect raw base64 leading bytes
  if (base64.startsWith("/9j/")) return "image/jpeg";
  if (base64.startsWith("iVBOR")) return "image/png";
  if (base64.startsWith("R0lGO")) return "image/gif";
  if (base64.startsWith("UklGR")) return "image/webp";

  return "image/png";
}
