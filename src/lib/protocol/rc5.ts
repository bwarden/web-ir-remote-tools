import { IRCode, parseIntVal, toHex } from '../code.js';
import type { BurstPair, DecodeParams, ProtocolHandler } from '../protocol.js';

const HALF = 889;
const CARRIER = 36000;

function manchesterBits(toggle: number, address: number, command: number): number[] {
  const start2 = (command & 0x40) ? 0 : 1;
  const cmd6 = command & 0x3f;
  const bits: number[] = [1, start2, toggle & 1];
  for (let i = 4; i >= 0; i--) bits.push((address >> i) & 1);
  for (let i = 5; i >= 0; i--) bits.push((cmd6 >> i) & 1);
  return bits;
}

// Build signed timing list (positive mark, negative space) per the Python
// reference, then strip leading/trailing spaces.
function buildTimings(toggle: number, address: number, command: number): number[] {
  const bits = manchesterBits(toggle, address, command);
  function appendSigned(timings: number[], value: number): void {
    if (timings.length && (timings[timings.length - 1] > 0) === (value > 0)) {
      timings[timings.length - 1] += value;
    } else {
      timings.push(value);
    }
  }
  const frame: number[] = [];
  for (const bit of bits) {
    if (bit) {
      appendSigned(frame, -HALF);
      appendSigned(frame, HALF);
    } else {
      appendSigned(frame, HALF);
      appendSigned(frame, -HALF);
    }
  }
  // strip leading space
  while (frame.length && frame[0] < 0) frame.shift();
  // strip trailing space
  while (frame.length && frame[frame.length - 1] < 0) frame.pop();
  return frame;
}

function expandSigned(timings: number[]): number[] {
  const out: number[] = [];
  for (const t of timings) {
    const n = Math.round(Math.abs(t) / HALF);
    const sign = t >= 0 ? 1 : -1;
    for (let i = 0; i < n; i++) out.push(sign * HALF);
  }
  return out;
}

function signedToPairs(timings: number[]): BurstPair[] {
  const flat = expandSigned(timings);
  const pairs: BurstPair[] = [];
  let i = 0;
  while (i < flat.length) {
    const mark = flat[i] > 0 ? flat[i] : 0;
    let space = 0;
    if (i + 1 < flat.length && flat[i + 1] < 0) {
      space = -flat[i + 1];
      i += 2;
    } else {
      i += 1;
    }
    pairs.push([mark, space]);
  }
  return pairs;
}

function pairsToSigned(pairs: BurstPair[]): number[] {
  const out: number[] = [];
  for (const [m, s] of pairs) {
    const mn = Math.round(m / HALF);
    for (let i = 0; i < mn; i++) out.push(HALF);
    const sn = Math.round(s / HALF);
    for (let i = 0; i < sn; i++) out.push(-HALF);
  }
  while (out.length && out[0] < 0) out.shift();
  while (out.length && out[out.length - 1] < 0) out.pop();
  return out;
}

export class Rc5Protocol implements ProtocolHandler {
  readonly name = 'RC5';

  decodeRaw(raw: string | number): IRCode {
    const val = parseIntVal(raw) >>> 0;
    const toggle = (val >> 11) & 1;
    const address = (val >> 6) & 0x1f;
    const command = val & 0x3f;
    // RC5X: if the field bit (S2) was 0, bit 6 of command is set.
    // We cannot recover S2 from the 12-bit value here; keep as-is.
    return new IRCode({
      protocol: this.name,
      bits: 12,
      address,
      subaddress: -1,
      command,
      data: val,
    });
  }

  decodeParams(args: DecodeParams): IRCode {
    const addr = parseIntVal(args.address ?? args.device ?? 0) & 0x1f;
    const cmd = parseIntVal(args.command ?? args.function ?? 0) & 0x3f;
    const toggle = 0;
    const data = (toggle << 11) | (addr << 6) | cmd;
    return new IRCode({
      protocol: this.name,
      bits: 12,
      address: addr,
      subaddress: -1,
      command: cmd,
      data,
    });
  }

  decodeTiming(burstPairs: BurstPair[]): IRCode | null {
    // Expand merged entries into half-bit units.
    const rawSigned = pairsToSigned(burstPairs);
    const signed: number[] = [];
    for (const t of rawSigned) {
      const n = Math.round(Math.abs(t) / HALF);
      const sign = t >= 0 ? 1 : -1;
      for (let i = 0; i < n; i++) signed.push(sign * HALF);
    }
    while (signed.length && signed[0] < 0) signed.shift();
    while (signed.length && signed[signed.length - 1] < 0) signed.pop();
    if (signed.length < 1) return null;
    if (signed[0] <= 0) return null;

    const bits: number[] = [1]; // first start bit
    let i = 1;
    while (i + 1 < signed.length) {
      const a = signed[i];
      const b = signed[i + 1];
      if (a < 0 && b > 0) bits.push(1);
      else if (a > 0 && b < 0) bits.push(0);
      else return null;
      i += 2;
    }
    if (i < signed.length) {
      // trailing half without its space: last bit is a 0
      if (signed[i] > 0) bits.push(0);
      else return null;
    }
    if (bits.length !== 14) return null;

    const s2 = bits[1];
    const toggle = bits[2];
    let address = 0;
    for (let k = 0; k < 5; k++) address = (address << 1) | bits[3 + k];
    let command = 0;
    for (let k = 0; k < 6; k++) command = (command << 1) | bits[8 + k];
    if (s2 === 0) command |= 0x40;
    const data = (toggle << 11) | (address << 6) | (command & 0x3f);
    return new IRCode({
      protocol: this.name,
      bits: 12,
      address,
      subaddress: -1,
      command,
      data,
    });
  }

  toPronto(code: IRCode): string {
    const toggle = ((code.data as number) >> 11) & 1;
    const address = code.address & 0x1f;
    const command = code.command & 0x7f;
    const bits = manchesterBits(toggle, address, command);

    const carrierHz = CARRIER;
    const freqWord = Math.round(1000000.0 / (carrierHz * 0.241246));
    const periodUs = freqWord * 0.241246;
    const usToPulses = (us: number) => Math.round(us / periodUs);

    const prontoPairs: BurstPair[] = [];
    for (const bit of bits) {
      if (bit === 0) {
        prontoPairs.push([usToPulses(HALF), usToPulses(HALF)]);
      } else {
        prontoPairs.push([0, usToPulses(HALF)]);
        prontoPairs.push([usToPulses(HALF), 0]);
      }
    }
    const seq1 = prontoPairs.length;
    const header = `0000 ${toHex(freqWord, 4)} ${toHex(seq1, 4)} 0000`;
    const payload = prontoPairs.map((p) => `${toHex(p[0], 4)} ${toHex(p[1], 4)}`).join(' ');
    return `${header} ${payload}`;
  }
}
