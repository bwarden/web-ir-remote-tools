// IRCode - intermediate representation of an IR remote control code.
//
// TypeScript port of IR::Code from the Perl IR::Code distribution
// (../ir-code). Every protocol handler decodes into an IRCode and every
// format exports from one, so a signal can move between protocols and
// formats without loss of information.

export interface IrsendPayload {
  Protocol: string;
  Bits: number;
  Data?: string;
}

export class IRCode {
  protocol = 'UNKNOWN';
  bits = 0;
  address = 0;
  subaddress = -1;
  command = 0;
  // The raw transmitted value. Most protocols pack into a JS number
  // (<= 48 bits); MWM frames can be up to 144 bits, so the value is a
  // bigint there. The rest of the pipeline treats it as opaque and only
  // ever formats it as hex (dataHex) or reads it back for a roundtrip.
  data?: number | bigint;
  alias = '';
  // The device-type name the code belongs to (brand/model from the Product
  // column of a code table). Empty for codes that carry no device identity.
  device = '';
  dittoCount = 0;
  // How many times the whole signal transmits per press (the wig's
  // send_count, the repeat hint a JSON dump's keycode carries). 0 means the
  // source carried no repeat count, so a wig export omits send_count and the
  // default single press is assumed.
  sendCount = 0;
  bypassProtocol = false;
  timings?: number[];
  // The original raw Pronto Hex of a signal no registered protocol
  // recognized, stashed verbatim so the code re-exports losslessly as a raw
  // (protocol 'UNKNOWN', bypassProtocol set) signal. Undefined for codes
  // built from decoded fields.
  pronto?: string;

  constructor(init?: Partial<IRCode>) {
    if (init) Object.assign(this, init);
  }

  // Tasmota IRSend JSON payload: Protocol, Bits, and (when known) Data, in
  // the display form Tasmota's Data field expects. For the protocols that
  // transmit every byte LSB-first (lsbIsAccumulated=true; NEC, JVC, SAMSUNG,
  // 48-NEC, JVC-48, SAMSUNG20) code.data is the accumulated form and has to
  // be bit-reversed byte by byte to reach the display value; whole-word
  // MSB-first protocols (SAMSUNG36, lsbIsAccumulated=false) and protocols
  // with no byte-order distinction emit code.data as-is. Pass the flag as
  // resolved from the protocol registry, e.g.
  // converter.getProtocol(proto)?.lsbIsAccumulated ?? true.
  toIrsend(lsbIsAccumulated?: boolean): IrsendPayload {
    const hash: IrsendPayload = { Protocol: this.protocol, Bits: this.bits };
    if (this.data !== undefined) {
      hash.Data = dataHex(
        lsbIsAccumulated === true && typeof this.data === 'number'
          ? bitReverseBytes(this.data, this.bits || 32)
          : this.data,
      );
    }
    return hash;
  }
}

// Uppercase hex with a fixed width, matching Perl's sprintf("%04X", ...).
export function toHex(value: number, width: number): string {
  return value.toString(16).toUpperCase().padStart(width, '0');
}

// The display hex of a data word, padded to the whole bytes the value needs
// (minimum 4 digits), exactly as Tasmota prints Data: leading zeros are
// trimmed to an even digit count, and the word is never truncated, so 36/48
// bit words keep every bit. Accepts bigint for protocols whose frames exceed
// 48 bits (MWM), where the value is a bigint.
export function dataHex(value: number | bigint): string {
  const s = value.toString(16);
  const hexDigits = s === '0' ? 1 : s.length;
  const width = Math.max(4, Math.ceil(hexDigits / 2) * 2);
  return '0x' + s.toUpperCase().padStart(width, '0');
}

// Reverse the bits within each of the `bits` significant bits of `value`,
// considered byte by byte (each byte is reversed as a whole, byte order is
// kept). NEC, JVC and SAMSUNG transmit every byte LSB-first, so the value a
// receiver accumulates (Tasmota DataLSB, the IRRemoteESP8266 value, the
// "LSB" column of the sample code tables) is the per-byte bit reversal of
// the display value (Tasmota Data, the "Code"/"MSB" column). The two forms
// map onto each other with this function, so a code can be imported from
// either byte order.
export function bitReverseBytes(value: number, bits: number): number {
  let out = 0;
  for (let i = 0; i < bits; i++) {
    const byte = i >> 3;
    const bit = i & 7;
    const src = 8 * byte + (7 - bit);
    // Multiplied by powers of two rather than shifted: JS shifts truncate to
    // 32 bits, but 36/48-bit words (SAMSUNG36, JVC-48, 48-NEC) exceed uint32.
    out += (Math.floor(value / 2 ** src) % 2) * 2 ** i;
  }
  return out;
}

// Parse a numeric or 0x-prefixed hex value, mirroring the _parse_int
// helpers in the Perl protocol modules.
export function parseIntVal(v: string | number | undefined | null): number {
  if (v === undefined || v === null || v === '') return 0;
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^0x/i.test(s)) return Number.parseInt(s.slice(2), 16);
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }
  return v;
}

// Parse a numeric or 0x-prefixed hex value that may exceed the JS safe
// integer range (MWM frames are up to 144 bits), returning a bigint. Small
// values are returned as plain numbers so the rest of the pipeline does not
// need to know whether a frame is wide.
export function parseIntBig(v: string | number | bigint | undefined | null): number | bigint {
  if (v === undefined || v === null || v === '') return 0;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^0x/i.test(s)) {
      const n = BigInt('0x' + s.slice(2));
      return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n;
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }
  return v;
}
