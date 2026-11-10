/** A limit or window of NaN, zero or a fraction would refuse everyone, or key every client alike. */
export function assertPositiveInteger({ name, value }: { name: string; value: number }): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive whole number (${name}: ${value})`);
  }
}
