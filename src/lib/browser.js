// Firefox exposes promise-based `browser`; Chromium MV3 `chrome.*` also returns promises.
export const api = globalThis.browser ?? globalThis.chrome;
