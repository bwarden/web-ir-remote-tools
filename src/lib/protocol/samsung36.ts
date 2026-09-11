// SAMSUNG36 protocol handler (36-bit), ported from IRremoteESP8266
// (Copyright David Conran et al., GPLv2, https://github.com/crankyoldgit/
// IRremoteESP8266, ir_Samsung.cpp sendSamsung36/decodeSamsung36).
//
// The 36-bit data word is transmitted in two blocks. Block #1 carries the top
// 16 bits (the address) behind a 4515/4438 us header; block #2 carries the
// remaining 20 bits (the command) with no header. Each block is sent MSB-first
// with a 512 us mark and a 1468 us (1) / 490 us (0) space, and each block ends
// with a 512 us mark; block #1's footer is followed by a 4438 us space and
// block #2's by the ~27 ms inter-message gap. The decoder reads both blocks
// MSB-first, so the stored data word is the same value the transmitter sent -
// what IRremoteESP8266 reports as `value`, the "Code" column of the sample
// tables. The "LSB" column is the same word read bit-for-bit in reverse.

import { IRCode, parseIntVal, toHex } from '../code.js';
import type { BurstPair, DecodeParams, ProtocolHandler } from '../protocol.js';

const BITS = 36;
const ADDR_BITS = 16; // block #1
const CMD_BITS = BITS - ADDR_BITS; // block #2 (20)
const BLOCK1_SHIFT = 1 << CMD_BITS; // 2^20: block #1 value is data / this

// Reverse the full `bits`-bit value end to end, without the 32-bit truncation
// of JS bitwise operators (36-bit words exceed uint32). Each `out * 2 + bit`
// step shifts earlier bits up, so feeding the original bits LSB-first builds
// the reversed word MSB-first.
function reverseBits(val: number, bits: number): number {
  let out = 0;
  for (let i = 0; i < bits; i++) {
    out = out * 2 + (Math.floor(val / 2 ** i) % 2);
  }
  return out;
}

// Pack the 16-bit address (block #1) and the 20-bit command (block #2) into
// the transmitted 36-bit word.
function encodeData(addr: number, cmd: number): number {
  return (addr & 0xffff) * BLOCK1_SHIFT + (cmd & (BLOCK1_SHIFT - 1));
}

export class Samsung36Protocol implements ProtocolHandler {
  readonly name = 'SAMSUNG36';

  // The 36-bit word is transmitted MSB-first as a whole, so Tasmota's "Data"
  // field is itself the accumulated form decodeRaw reads. Tasmota's "DataLSB"
  // (the per-byte bit reversal of the low 32 bits) is a display artifact that
  // cannot reconstruct the transmitted value, so Data is preferred.
  readonly lsbIsAccumulated = false;

  // decodeRaw expects the display form (the "Code" column / IRremoteESP8266
  // `value`): the word read MSB-first, address in the top 16 bits.
  decodeRaw(raw: string | number): IRCode {
    const val = parseIntVal(raw);
    return new IRCode({
      protocol: this.name,
      bits: BITS,
      address: Math.floor(val / BLOCK1_SHIFT) & 0xffff,
      subaddress: -1,
      command: val % BLOCK1_SHIFT,
      data: val,
    });
  }

  // The LSB form is the same word reversed end to end, so it has to be
  // reversed (not per-byte, as for NEC/JVC/SAMSUNG) to reach the display
  // form decodeRaw reads.
  decodeByteOrder(raw: string | number, lsb: boolean): IRCode {
    const val = parseIntVal(raw);
    return this.decodeRaw(lsb ? reverseBits(val, BITS) : val);
  }

  decodeParams(args: DecodeParams): IRCode {
    const addr = parseIntVal(args.address ?? args.device ?? 0);
    const cmd = parseIntVal(args.command ?? args.function ?? 0);
    return new IRCode({
      protocol: this.name,
      bits: BITS,
      address: addr,
      subaddress: -1,
      command: cmd,
      data: encodeData(addr, cmd),
    });
  }

  // Decode microsecond timing pairs into an IRCode, or null when the timing
  // signature does not match. Frame layout (BITS = 36):
  //   [header 4515/4438] [16 addr bits] [mark/4438] [20 cmd bits] [mark/26880]
  // so 1 + 16 + 1 + 20 + 1 = 39 burst pairs. A capture may end on a bare
  // trailing mark, in which case the final space reads as 0.
  decodeTiming(burstPairs: BurstPair[]): IRCode | null {
    if (burstPairs.length < 39) return null;

    const [hdrMark, hdrSpace] = burstPairs[0];
    if (!(hdrMark >= 3800 && hdrMark <= 5200 && hdrSpace >= 3800 && hdrSpace <= 5200)) {
      return null;
    }

    let block1 = 0;
    for (let i = 0; i < ADDR_BITS; i++) {
      const space = burstPairs[i + 1][1];
      block1 = block1 * 2 + (space > 1000 ? 1 : 0);
    }

    const [midMark, midSpace] = burstPairs[ADDR_BITS + 1];
    if (!(midMark >= 400 && midMark <= 900 && midSpace >= 3800 && midSpace <= 5200)) {
      return null;
    }

    let block2 = 0;
    for (let i = 0; i < CMD_BITS; i++) {
      const space = burstPairs[i + ADDR_BITS + 2][1];
      block2 = block2 * 2 + (space > 1000 ? 1 : 0);
    }

    const [stopMark, stopSpace] = burstPairs[ADDR_BITS + CMD_BITS + 2];
    if (!(stopMark >= 400 && stopMark <= 900 && (stopSpace === 0 || stopSpace >= 8000))) {
      return null;
    }

    const data = block1 * BLOCK1_SHIFT + block2;

    return new IRCode({
      protocol: this.name,
      bits: BITS,
      address: block1,
      subaddress: -1,
      command: block2,
      data,
    });
  }

  toPronto(code: IRCode): string {
    const carrierHz = 38000;
    const freqWord = Math.round(1000000.0 / (carrierHz * 0.241246));
    const periodUs = freqWord * 0.241246;
    const usToPulses = (us: number) => Math.round(us / periodUs);

    const data = encodeData(code.address, code.command);
    const block1 = Math.floor(data / BLOCK1_SHIFT) & 0xffff;
    const block2 = data % BLOCK1_SHIFT;

    const burstPairs: BurstPair[] = [[usToPulses(4515), usToPulses(4438)]];
    for (let i = ADDR_BITS - 1; i >= 0; i--) {
      const bit = (block1 >>> i) & 1;
      burstPairs.push([usToPulses(512), usToPulses(bit ? 1468 : 490)]);
    }
    burstPairs.push([usToPulses(512), usToPulses(4438)]);
    for (let i = CMD_BITS - 1; i >= 0; i--) {
      const bit = (block2 >>> i) & 1;
      burstPairs.push([usToPulses(512), usToPulses(bit ? 1468 : 490)]);
    }
    burstPairs.push([usToPulses(512), usToPulses(26880)]);

    const seq1 = burstPairs.length;
    const header = `0000 ${toHex(freqWord, 4)} ${toHex(seq1, 4)} 0000`;
    const payload = burstPairs.map((p) => `${toHex(p[0], 4)} ${toHex(p[1], 4)}`).join(' ');
    return `${header} ${payload}`;
  }
}
