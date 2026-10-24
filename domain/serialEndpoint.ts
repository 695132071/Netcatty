// Keep in sync with electron/bridges/serialNamedPipe.cjs.
export function isWindowsNamedPipePath(value: string): boolean {
  return /^\\\\[.?]\\pipe\\[^\r\n\0]+$/i.test(value);
}

export function isSerialEndpointPath(value: string): boolean {
  return value.startsWith('/dev/') || /^COM\d+$/i.test(value)
    || /^\\\\\.\\COM\d+$/i.test(value) || isWindowsNamedPipePath(value);
}
