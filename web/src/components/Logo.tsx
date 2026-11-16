/* eslint-disable @next/next/no-img-element */

/** The BluesandAI mark (the triangle), from public/brand/bluesandai-mark.png. */
export function LogoMark({ size = 24 }: { size?: number }) {
  return <img src="/brand/bluesandai-mark.png" width={size} height={size} alt="" aria-hidden="true" className="shrink-0" />;
}

/** The BluesandAI logo (mark and wordmark): a white wordmark on the dark theme, the original blue on the light one
 * (globals.css swaps .brand-dark / .brand-light). */
export function LogoFull({ height = 28 }: { height?: number }) {
  const style = { height, width: "auto" };
  return (
    <span className="inline-flex shrink-0">
      <img src="/brand/bluesandai-logo-dark.png?v=2" height={height} style={style} alt="BluesandAI" className="brand-dark" />
      <img src="/brand/bluesandai-logo.png" height={height} style={style} alt="BluesandAI" className="brand-light" />
    </span>
  );
}

export function Logo() {
  return <LogoFull height={34} />;
}
