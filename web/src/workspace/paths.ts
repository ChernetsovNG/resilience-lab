/** Resolves [ref] against the directory of [documentPath] like the core `Lab.resolveRef`; null when it leaves the workspace. */
export function resolveRef(documentPath: string, ref: string): string | null {
  if (ref.startsWith("/") || ref.includes("\\") || ref.includes("://")) return null;
  const slash = documentPath.lastIndexOf("/");
  const base = slash < 0 ? "" : documentPath.slice(0, slash);
  const segments: string[] = [];
  for (const segment of (base === "" ? ref : `${base}/${ref}`).split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.length === 0 ? null : segments.join("/");
}
