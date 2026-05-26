// GSM-7 / UCS-2 segment math.
//
// Twilio's segment calculator (https://github.com/twilio/messaging-segment-calculator)
// is a standalone web app, not a published npm library, so we implement the
// well-defined algorithm directly:
//
// GSM-7 — 7-bit alphabet, single segment up to 160 chars, multi-segment 153
//   (the UDH eats 7 chars). 9 chars in the GSM-7 extension table count as 2.
// UCS-2 — used when any char is outside the GSM-7 set. Single segment 70 UTF-16
//   code units, multi-segment 67. Emoji in supplementary planes (😀, 👨‍👩‍👧, …)
//   are encoded as surrogate pairs and count as 2 code units each — JS
//   String.length already gives us that.

const GSM_7_BASIC = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'
);
const GSM_7_EXTENSION = new Set('\f^{}\\[~]|€');
// Unicode extended-pictographic — close enough for a UI hint; flagging false
// negatives for obscure cases is acceptable because the encoding is the source
// of truth for routing/billing.
const EMOJI_RE = /\p{Extended_Pictographic}/u;

const GSM_SINGLE_MAX = 160;
const GSM_MULTI_MAX = 153;
const UCS_SINGLE_MAX = 70;
const UCS_MULTI_MAX = 67;

function isGsm(text) {
  for (const ch of text) {
    if (!GSM_7_BASIC.has(ch) && !GSM_7_EXTENSION.has(ch)) return false;
  }
  return true;
}

function gsmCharCount(text) {
  let count = 0;
  for (const ch of text) {
    count += GSM_7_EXTENSION.has(ch) ? 2 : 1;
  }
  return count;
}

export function computeSegments(rawBody) {
  const body = rawBody == null ? '' : String(rawBody);
  const hasEmoji = EMOJI_RE.test(body);
  const gsm = isGsm(body);

  let characterCount;
  let singleMax;
  let multiMax;
  let encoding;

  if (gsm) {
    encoding = 'GSM-7';
    characterCount = gsmCharCount(body);
    singleMax = GSM_SINGLE_MAX;
    multiMax = GSM_MULTI_MAX;
  } else {
    encoding = 'UCS-2';
    characterCount = body.length; // JS strings are UTF-16, matches UCS-2 code-unit count
    singleMax = UCS_SINGLE_MAX;
    multiMax = UCS_MULTI_MAX;
  }

  let segmentCount;
  if (characterCount === 0) segmentCount = 0;
  else if (characterCount <= singleMax) segmentCount = 1;
  else segmentCount = Math.ceil(characterCount / multiMax);

  return {
    encoding,
    segmentCount,
    characterCount,
    singleMax,
    multiMax,
    hasEmoji,
  };
}
