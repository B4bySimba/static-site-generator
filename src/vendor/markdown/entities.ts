/**
 * HTML entity decoding.
 *
 * The full HTML5 named-character-reference table has ~2,200 entries and would dwarf this
 * file. We ship the ones that actually appear in prose, plus complete support for numeric
 * references (`&#169;`, `&#xA9;`) which cover everything else — an author can always write
 * the code point. Unknown named entities are left verbatim rather than silently dropped.
 */

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  laquo: "«", raquo: "»", deg: "°", plusmn: "±", times: "×", divide: "÷",
  frac12: "½", frac14: "¼", frac34: "¾", sup2: "²", sup3: "³",
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", pi: "π", sigma: "σ", omega: "ω",
  Alpha: "Α", Beta: "Β", Gamma: "Γ", Delta: "Δ", Pi: "Π", Sigma: "Σ", Omega: "Ω",
  larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔",
  ne: "≠", le: "≤", ge: "≥", asymp: "≈", equiv: "≡", infin: "∞",
  sum: "∑", prod: "∏", radic: "√", int: "∫", part: "∂",
  bull: "•", dagger: "†", sect: "§", para: "¶", middot: "·",
  euro: "€", pound: "£", yen: "¥", cent: "¢",
  eacute: "é", egrave: "è", agrave: "à", ccedil: "ç", uuml: "ü", ouml: "ö", auml: "ä",
  ntilde: "ñ", aring: "å", oslash: "ø", szlig: "ß",
};

/** Decode a single entity token such as "&amp;", "&#169;" or "&#xA9;". */
export function decodeEntities(entity: string): string {
  const body = entity.slice(1, -1);

  if (body.startsWith("#")) {
    const isHex = body[1] === "x" || body[1] === "X";
    const code = parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
    // 0 and out-of-range code points map to U+FFFD, per the HTML spec.
    if (!Number.isFinite(code) || code === 0 || code > 0x10ffff) return "�";
    // Lone surrogates are not valid scalar values.
    if (code >= 0xd800 && code <= 0xdfff) return "�";
    return String.fromCodePoint(code);
  }

  const named = NAMED[body];
  return named ?? entity; // unknown: leave it exactly as written
}

/** Decode every entity in a string. */
export function decodeAllEntities(text: string): string {
  return text.replace(
    /&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g,
    (match) => decodeEntities(match),
  );
}
