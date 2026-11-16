// Which downloaded files the machine reads as text: markdown, plain text and csv, one megabyte
// at most. A port refuses anything else before it reads a byte of the content.

export const TEXT_FILE_LIMIT = 1_048_576;

const TEXT_EXTENSIONS = /\.(md|markdown|txt|csv)$/i;

/** True for a text-like file, by its mimetype (`text/*`) or, when that is generic, its extension. */
export function isTextLike(name: string, mimetype: string): boolean {
  return mimetype.toLowerCase().startsWith("text/") || TEXT_EXTENSIONS.test(name);
}

/** Why a file of this name, type and size may not be read, or null when it may. */
export function textFileRefusal(name: string, mimetype: string, size: number | null): string | null {
  if (!isTextLike(name, mimetype)) return `${name} is not a text file (md, txt or csv)`;
  if (size !== null && size > TEXT_FILE_LIMIT) return `${name} is over 1 MB`;
  return null;
}
