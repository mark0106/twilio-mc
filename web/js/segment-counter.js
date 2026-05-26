// Mirrors the server's segments.js so the live counter in the composer agrees
// with the values stored when /sends is POSTed. If these diverge, the user
// would see one count while typing and a different one in the review modal.

const GSM_7_BASIC = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'
);
const GSM_7_EXTENSION = new Set('\f^{}\\[~]|€');
const EMOJI_RE = /\p{Extended_Pictographic}/u;

const GSM_SINGLE_MAX = 160;
const GSM_MULTI_MAX = 153;
const UCS_SINGLE_MAX = 70;
const UCS_MULTI_MAX = 67;

export function analyzeMessage(text) {
  const body = text == null ? '' : String(text);
  const hasEmoji = EMOJI_RE.test(body);

  let isGsm = true;
  for (const ch of body) {
    if (!GSM_7_BASIC.has(ch) && !GSM_7_EXTENSION.has(ch)) {
      isGsm = false;
      break;
    }
  }

  let charCount, singleMax, multiMax, encoding;
  if (isGsm) {
    encoding = 'GSM-7';
    charCount = 0;
    for (const ch of body) charCount += GSM_7_EXTENSION.has(ch) ? 2 : 1;
    singleMax = GSM_SINGLE_MAX;
    multiMax = GSM_MULTI_MAX;
  } else {
    encoding = 'UCS-2';
    charCount = body.length;
    singleMax = UCS_SINGLE_MAX;
    multiMax = UCS_MULTI_MAX;
  }

  let segments;
  if (charCount === 0) segments = 0;
  else if (charCount <= singleMax) segments = 1;
  else segments = Math.ceil(charCount / multiMax);

  return { encoding, charCount, segments, singleMax, multiMax, hasEmoji };
}
