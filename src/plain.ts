/**
 * A plain-data copy of a value, safe to pass to window.api. Electron copies IPC arguments with
 * the structured clone algorithm, which rejects Vue's reactive proxies with
 * "An object could not be cloned".
 */
export function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
