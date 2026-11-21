/**
 * Reads a required environment variable at cold start. Failing on load makes a missing
 * CDK wiring obvious in the first invocation instead of surfacing as odd runtime errors.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}
