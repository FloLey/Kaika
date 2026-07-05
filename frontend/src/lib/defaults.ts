// Fill any missing fields of a stored (possibly partial or absent) settings object
// from its defaults. Shared by the output + export settings modules, which each keep
// their own typed wrapper around it.
export function withDefaults<T extends object>(defaults: T, partial?: Partial<T> | null): T {
  return { ...defaults, ...(partial || {}) };
}
