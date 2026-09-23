/**
 * A standalone, colorable cairn glyph - the same three-stone mark as
 * Logo.tsx's CairnMark, but with a selectable tone so it can echo
 * "connected/verified" (moss) inside the wallet panel instead of always
 * reading as the static brass brand mark.
 */

const TONES = {
  brass: ["#96723f", "#bd935e", "#e2bd88"],
  moss: ["#4f6647", "#7fa06f", "#aecb9d"],
} as const;

export function CairnGlyph({ size = 40, tone = "brass" }: { size?: number; tone?: keyof typeof TONES }) {
  const [base, mid, peak] = TONES[tone];
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="7" y="25.5" width="26" height="9" rx="4.5" fill={base} transform="rotate(-3 20 30)" />
      <rect x="10.5" y="17" width="19" height="8" rx="4" fill={mid} transform="rotate(4 20 21)" />
      <rect x="13" y="9.5" width="12" height="7" rx="3.5" fill={peak} transform="rotate(-5 19 13)" />
    </svg>
  );
}
