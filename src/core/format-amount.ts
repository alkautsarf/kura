// Compact decimal formatter for token amounts. Truncates to a small number of
// significant figures so values stay glanceable in tight UI surfaces (Touch ID
// prompts, activity rows, popup headlines). Sign is extracted first so BigInt
// division doesn't render "0.-1" for small negatives.
export function fmtCompact(rawWei: string, decimals: number, sigFigs = 4): string {
  let big: bigint;
  try {
    big = BigInt(rawWei);
  } catch {
    return "?";
  }
  const sign = big < 0n ? "-" : "";
  if (big < 0n) big = -big;
  const div = 10n ** BigInt(decimals);
  const whole = big / div;
  const frac = big % div;
  if (whole > 0n) {
    const wholeStr = whole.toString();
    const remaining = Math.max(0, sigFigs - wholeStr.length);
    if (remaining === 0) return sign + wholeStr;
    const fracStr = frac.toString().padStart(decimals, "0").slice(0, remaining).replace(/0+$/, "");
    return fracStr.length > 0 ? `${sign}${wholeStr}.${fracStr}` : sign + wholeStr;
  }
  const fracStr = frac.toString().padStart(decimals, "0");
  const firstNonZero = fracStr.search(/[1-9]/);
  if (firstNonZero === -1) return sign + "0";
  const truncated = fracStr.slice(0, firstNonZero + sigFigs).replace(/0+$/, "");
  return `${sign}0.${truncated}`;
}
