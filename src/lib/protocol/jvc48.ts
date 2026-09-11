// JVC-48 protocol handler (48-bit, Kaseikyo family OEM code 3/1), from the
// DecodeIR definition:
//
//   {37k,432}<1,-1|1,-3>(8,-4,3:8,1:8,D:8,S:8,F:8,(D^S^F):8,1,-173)+
//
// Six bytes are transmitted in order (OEM1=3, OEM2=1, device, subdevice,
// function, checksum) behind a 3456/1728 us header.  The frame is structured
// identically to Panasonic (Kaseikyo family) with different OEM codes.  The
// 32-bit value is transmitted with the most significant byte first and each
// byte MSB-first within (per the IRP `:8` default), so the value collected
// from a capture (and stored in ->data) is the per-byte bit reversal of the
// display form (Tasmota Data).  The checksum byte is device^subdevice^function,
// the same rule the Panasonic member of the Kaseikyo family uses.

import { IRCode, bitReverseBytes, parseIntVal, toHex } from '../code.js';
import type { BurstPair, DecodeParams, ProtocolHandler } from '../protocol.js';

const BITS = 48;
const OEM1 = 3;
const OEM2 = 1;

function reverseBits(val: number): number {
  let out = 0;
  for (let i = 0; i < 8; i++) {
    out |= ((val >> i) & 1) << (7 - i);
  }
  return out;
}

// Pack device/subdevice/function into the transmitted 48-bit accumulated
// value, computing the checksum byte per the D^S^F rule.
function encodeData(addr: number, subaddr: number, cmd: number): number {
  const a = addr & 0xff;
  const s = subaddr & 0xff;
  const f = cmd & 0xff;
  return (
    OEM1 * 2 ** 40 +
    OEM2 * 2 ** 32 +
    a * 2 ** 24 +
    s * 2 ** 16 +
    f * 2 ** 8 +
    (a ^ s ^ f)
  );
}

export class Jvc48Protocol implements ProtocolHandler {
  readonly name = 'JVC-48';

  readonly lsbIsAccumulated = true;

  decodeRaw(raw: string | number): IRCode {
    const val = parseIntVal(raw);
    return this.decodeParams({
      address: reverseBits(Math.floor(val / 2 ** 24) & 0xff),
      subaddress: reverseBits(Math.floor(val / 2 ** 16) & 0xff),
      command: reverseBits(Math.floor(val / 2 ** 8) & 0xff),
    });
  }

  // decodeRaw expects the display form (Tasmota Data): the frame bytes are
  // bit-reversed on the wire, so the accumulated value (Tasmota DataLSB) has
  // to be bit-reversed byte by byte to reach the display form.
  decodeByteOrder(raw: string | number, lsb: boolean): IRCode {
    const val = parseIntVal(raw);
    return this.decodeRaw(lsb ? bitReverseBytes(val, BITS) : val);
  }

  decodeParams(args: DecodeParams): IRCode {
    const addr = parseIntVal(args.address ?? args.device ?? 0) & 0xff;
    const subaddrArg = parseIntVal(args.subaddress ?? args.subdevice ?? -1);
    const cmd = parseIntVal(args.command ?? args.function ?? 0) & 0xff;
    const subaddr = subaddrArg === -1 ? 0 : subaddrArg & 0xff;

    return new IRCode({
      protocol: this.name,
      bits: BITS,
      address: addr,
      subaddress: subaddrArg,
      command: cmd,
      data: encodeData(addr, subaddr, cmd),
    });
  }

  // Decode microsecond timing pairs into an IRCode, or null when the timing
  // signature does not match. A single frame is 1 header + 48 bits + 1 stop
  // burst pair; the IRP's trailing `+` repeats that whole frame.
  decodeTiming(burstPairs: BurstPair[]): IRCode | null {
    if (burstPairs.length < 50) return null; // Header + 48 bits + Stop

    const [hdrMark, hdrSpace] = burstPairs[0];

    // JVC-48 Header Check: ~3456us mark, ~1728us space (8/-4 of 432us).
    if (!(hdrMark >= 2800 && hdrMark <= 4100 && hdrSpace >= 1300 && hdrSpace <= 2100)) {
      return null;
    }

    const bytes = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 48; i++) {
      const space = burstPairs[i + 1][1];
      // Space ~1296us = 1, ~432us = 0
      const bit = space > 800 ? 1 : 0;
      bytes[i >> 3] |= bit << (i & 7); // LSB-first
    }

    // Stop bit: a short mark followed by the ~74ms inter-frame space. A
    // capture may end on a bare trailing mark with no space.
    const [stopMark, stopSpace] = burstPairs[49];
    if (!(stopMark >= 300 && stopMark <= 700 && (stopSpace === 0 || stopSpace >= 4000))) {
      return null;
    }

    const [b0, b1, b2, b3, b4, b5] = bytes as [number, number, number, number, number, number];

    // Validate JVC-48 OEM codes (3, 1). Frames with other OEM bytes belong
    // to a different Kaseikyo-family protocol (e.g. Panasonic with 0x40,0x04).
    if (b0 !== OEM1 || b1 !== OEM2) return null;

    // Validate checksum: device ^ subdevice ^ function
    if (b5 !== (b2 ^ b3 ^ b4)) return null;

    const data =
      b0 * 2 ** 40 + b1 * 2 ** 32 + b2 * 2 ** 24 + b3 * 2 ** 16 + b4 * 2 ** 8 + b5;

    return new IRCode({
      protocol: this.name,
      bits: BITS,
      address: b2,
      subaddress: b3,
      command: b4,
      data,
    });
  }

  toPronto(code: IRCode): string {
    const carrierHz = 37000;
    const freqWord = Math.round(1000000.0 / (carrierHz * 0.241246));
    const periodUs = freqWord * 0.241246;
    const usToPulses = (us: number) => Math.round(us / periodUs);

    const addr = code.address & 0xff;
    const subaddr = code.subaddress === -1 ? 0 : code.subaddress & 0xff;
    const cmd = code.command & 0xff;
    const data = encodeData(addr, subaddr, cmd);

    // The value is transmitted with the most significant byte first and each
    // byte MSB-first within. The wire bytes are the MSB display form
    // (Tasmota's Data field), which is the per-byte bit reversal of the
    // collected value.
    const msbVal = bitReverseBytes(data, BITS);

    const bits: number[] = [];
    for (let i = 47; i >= 0; i--) {
      bits.push((Math.floor(msbVal / 2 ** i) % 2));
    }

    const burstPairs: BurstPair[] = [[usToPulses(3456), usToPulses(1728)]];
    for (const bit of bits) {
      burstPairs.push([usToPulses(432), usToPulses(bit ? 1296 : 432)]);
    }

    // The trailing mark and ~74ms gap (1,-173 of 432us).
    burstPairs.push([usToPulses(432), usToPulses(74736)]);

    const seq1 = burstPairs.length;
    const header = `0000 ${toHex(freqWord, 4)} ${toHex(seq1, 4)} 0000`;
    const payload = burstPairs.map((p) => `${toHex(p[0], 4)} ${toHex(p[1], 4)}`).join(' ');
    return `${header} ${payload}`;
  }
}
