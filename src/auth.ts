// Hardcoded fixture per the exercise.
const TOKENS = new Map<string, string>([
  ['test-token-a', 'operator-a'],
  ['test-token-b', 'operator-b'],
]);

export function operatorFromAuthHeader(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer (\S+)$/.exec(header);
  if (!match) return null;
  return TOKENS.get(match[1]) ?? null;
}
