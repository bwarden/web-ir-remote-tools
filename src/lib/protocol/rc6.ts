import { IRCode, parseIntVal, toHex } from '../code.js';
import type { BurstPair, DecodeParams, ProtocolHandler } from '../protocol.js';

const TICK = 444;
const CARRIER = 36000;
const N_BITS = 20;

export class Rc6Protocol implements ProtocolHandler {
  readonly name = 'RC6';

  decodeRaw(raw: string | number): IRCode {
    const val = parseIntVal(raw) >>> 0;
    return new IRCode({
      protocol: this.name,
      bits: N_BITS,
      address: (val >> 8) & 0xff,
      subaddress: -1,
      command: val & 0xff,
      data: val,
    });
  }

  decodeParams(args: DecodeParams): IRCode {
    const addr = parseIntVal(args.address ?? args.device ?? 0) & 0xff;
    const cmd = parseIntVal(args.command ?? args.function ?? 0) & 0xff;
    const data = ((addr & 0xff) << 8) | (cmd & 0xff);
    return new IRCode({
      protocol: this.name,
      bits: N_BITS,
      address: addr,
      subaddress: -1,
      command: cmd,
      data,
    });
  }

  decodeTiming(burstPairs: BurstPair[]): IRCode | null {
    // Expand pairs into tick units.
    const expanded: number[] = [];
    for (const [m, s] of burstPairs) {
      const mn = Math.round(m / TICK);
      for (let i = 0; i < mn; i++) expanded.push(TICK);
      const sn = Math.round(s / TICK);
      for (let i = 0; i < sn; i++) expanded.push(-TICK);
    }
    // Header: 6 marks + 2 spaces
    if (expanded.length < 8 + 2 * N_BITS + 2) return null;
    for (let i = 0; i < 6; i++) if (expanded[i] <= 0) return null;
    if (expanded[6] >= 0 || expanded[7] >= 0) return null;

    let idx = 8;
    // start bit: mark then space
    if (idx + 1 >= expanded.length) return null;
    if (expanded[idx] <= 0 || expanded[idx + 1] >= 0) return null;
    idx += 2;

    let data = 0;
    for (let bitIndex = 0; bitIndex < N_BITS; bitIndex++) {
      const w = bitIndex === 3 ? 2 : 1;
      if (idx + 2 * w > expanded.length) return null;
      const levelA = expanded[idx] > 0 ? 1 : -1;
      for (let k = 0; k < w; k++) if ((expanded[idx + k] > 0 ? 1 : -1) !== levelA) return null;
      idx += w;
      const levelB = expanded[idx] > 0 ? 1 : -1;
      for (let k = 0; k < w; k++) if ((expanded[idx + k] > 0 ? 1 : -1) !== levelB) return null;
      idx += w;

      if (levelA === 1 && levelB === -1) data = (data << 1) | 1;
      else if (levelA === -1 && levelB === 1) data = data << 1;
      else return null;
    }

    return new IRCode({
      protocol: this.name,
      bits: N_BITS,
      address: (data >> 8) & 0xff,
      subaddress: -1,
      command: data & 0xff,
      data,
    });
  }

  toPronto(code: IRCode): string {
    const data = (code.data as number) >>> 0;
    const carrierHz = CARRIER;
    const freqWord = Math.round(1000000.0 / (carrierHz * 0.241246));
    const periodUs = freqWord * 0.241246;
    const usToPulses = (us: number) => Math.round(us / periodUs);
    const tickP = usToPulses(TICK);

    const prontoPairs: BurstPair[] = [];
    // header
    prontoPairs.push([usToPulses(6 * TICK), usToPulses(2 * TICK)]);
    // start bit
    prontoPairs.push([tickP, tickP]);
    for (let i = 0; i < N_BITS; i++) {
      const w = i === 3 ? 2 : 1;
      const bit = (data >> (N_BITS - 1 - i)) & 1;
      if (bit === 1) {
        prontoPairs.push([w * tickP, w * tickP]);
      } else {
        prontoPairs.push([0, w * tickP]);
        prontoPairs.push([w * tickP, 0]);
      }
    }

    const seq1 = prontoPairs.length;
    const header = `0000 ${toHex(freqWord, 4)} ${toHex(seq1, 4)} 0000`;
    const payload = prontoPairs.map((p) => `${toHex(p[0], 4)} ${toHex(p[1], 4)}`).join(' ');
    return `${header} ${payload}`;
  }
}
