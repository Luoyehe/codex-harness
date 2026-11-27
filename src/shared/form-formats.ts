export type FormDialect = 'draft-07' | '2019-09' | '2020-12';

export function parseFormDialect(declaration: unknown): FormDialect | null {
  if (declaration === undefined) return 'draft-07';
  if (typeof declaration !== 'string') return null;
  const uri = declaration.replace(/#$/, '');
  if (uri === 'http://json-schema.org/draft-07/schema' || uri === 'https://json-schema.org/draft-07/schema') return 'draft-07';
  if (uri === 'https://json-schema.org/draft/2019-09/schema') return '2019-09';
  if (uri === 'https://json-schema.org/draft/2020-12/schema') return '2020-12';
  return null;
}

export function validFormDivisor(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

// JSON numbers reach the form as JS numbers. Use their round-trippable decimal
// spelling, so 0.3 is exactly three steps of 0.1 and scientific notation is exact.
function decimalParts(value: number): { coefficient: bigint; exponent: number } {
  const [mantissa = '', scale] = Math.abs(value).toString().split('e');
  const point = mantissa.indexOf('.');
  const decimals = point < 0 ? 0 : mantissa.length - point - 1;
  return { coefficient: BigInt(mantissa.replace('.', '')), exponent: Number(scale ?? 0) - decimals };
}

export function isFormMultiple(step: number, value: number): boolean {
  if (!validFormDivisor(step) || !Number.isFinite(value)) return false;
  if (value === 0 || step === 1) return Number.isInteger(value);
  const data = decimalParts(value), divisor = decimalParts(step);
  const difference = data.exponent - divisor.exponent;
  // Finite IEEE-754 inputs bound this power to a few hundred decimal places.
  if (difference >= 0) return (data.coefficient * 10n ** BigInt(difference)) % divisor.coefficient === 0n;
  return data.coefficient % (divisor.coefficient * 10n ** BigInt(-difference)) === 0n;
}
