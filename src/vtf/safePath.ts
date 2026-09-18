/**
 * Path safety checker matching legacy VtfPackager.IsSafeRelativePath.
 *
 * Rejects:
 *   - Empty or whitespace
 *   - Backslashes (Windows-style path traversal)
 *   - Leading slashes (absolute Unix paths)
 *   - Drive letters ("C:/")
 *   - ".." or "." path segments
 */
export function isSafeRelativePath(path: string): boolean {
  if (!path || path.trim().length === 0) return false;
  if (path.includes("\\")) return false;
  if (path.startsWith("/")) return false;
  if (path.length >= 2 && path[1] === ":") return false;

  const segments = path.split("/");
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === ".." || seg === ".") return false;
  }

  return true;
}
