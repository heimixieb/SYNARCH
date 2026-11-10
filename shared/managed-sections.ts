/** A Chief's `managedSections` entry that covers every department, including ones added later. */
export const ALL_DEPARTMENTS = "*";

/** Whether a Chief's saved grants cover the department `section` (already trimmed); invalid entries fail closed. */
export function managesSection(managedSections: unknown, section: string): boolean {
  return Array.isArray(managedSections) && managedSections.some(value =>
    typeof value === "string" && (value === ALL_DEPARTMENTS || value.trim() === section));
}

/** The departments a Chief manages, as words: `all` alone once every department is covered, `general` for the unnamed one. */
export function managedNames(managedSections: readonly string[], all: string, general: string): string[] {
  return managedSections.includes(ALL_DEPARTMENTS) ? [all] : managedSections.map(name => name || general);
}
