const DEFAULTS = { retries: 3, timeoutMs: 1000, verbose: false };

export function createConfig(input) {
  return Object.assign(DEFAULTS, input);
}
