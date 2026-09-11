// Panasonic (Kaseikyo family) protocol handler (48-bit), from the DecodeIR
// definition:
//
//   {36k,432}<1,-1|1,-3>(8,-4,M:8,ID:8,D:8,S:8,F:8,(D^S^F):8,1,-173)+
//
// Six bytes are transmitted in order (Mfg_hi, Mfg_lo, device, subdevice,
// function, checksum) behind a 3456/1728 us header.  The frame is structured
// identically to JVC-48 (Kaseikyo family) with different OEM codes.  The
// 48-bit value is transmitted with the most significant byte first and each
// byte MSB-first within (per the IRP `:8` default).  Our LSB-first decoder
// accumulates each wire byte with its bits reversed, so the stored value
// (Tasmota DataLSB) has per-byte bit-reversed OEM and device/function bytes.
// The address and command fields follow the IRDB convention: they store the
// bit-reversed wire byte (e.g. wire device 0x01 → address 128 = 0x80), which
// is the accumulated form the decoder naturally produces.  The checksum byte
// is device^subdevice^function in the IRDB (accumulated) convention.
//
// Panasonic manufacturer codes observed: 0x40 (Matsushita/Panasonic).
// This handler hardcodes 0x4004; codes from other manufacturer families
// (different Mfg_hi/Mfg_lo) should use a separate protocol handler.

import { IRCode, bitReverseBytes, parseIntVal, toHex } from '../code.js';
import type { BurstPair, DecodeParams, ProtocolHandler } from '../protocol.js';

const BITS = 48;
const CARRIER_HZ = 36000;
const MFG_HI = 0x40;
const MFG_LO = 0x04;

function reverseBits(val: number): number {
  let out = 0;
  for (let i = 0; i < 8; i++) {
    out |= ((val >> i) & 1) << (7 - i);
  }
  return out;
}

// Pack device/subdevice/function into the transmitted 48-bit accumulated
// value, computing the checksum byte per the D^S^F rule.  The address and
// command follow the IRDB convention (bit-reversed wire bytes), so the OEM
// bytes must also be reversed to match the accumulated form.
function encodeData(addr: number, subaddr: number, cmd: number): number {
  const a = addr & 0xff;
  const s = subaddr & 0xff;
  const f = cmd & 0xff;
  return (
    reverseBits(MFG_HI) * 2 ** 40 +
    reverseBits(MFG_LO) * 2 ** 32 +
    a * 2 ** 24 +
    s * 2 ** 16 +
    f * 2 ** 8 +
    (a ^ s ^ f)
  );
}

export class PanasonicProtocol implements ProtocolHandler {
  readonly name = 'PANASONIC';

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
  // bit-reversed on the wire, so each byte in the display form must be
  // reversed to reach the accumulated / IRDB convention for address and command.
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

  decodeTiming(burstPairs: BurstPair[]): IRCode | null {
    if (burstPairs.length < 50) return null; // Header + 48 bits + Stop

    const [hdrMark, hdrSpace] = burstPairs[0];

    // Panasonic Header Check: ~3456us mark, ~1728us space (8/-4 of 432us).
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

    // Stop bit: a short mark followed by the long trailing space. A
    // capture may end on a bare trailing mark with no space.
    const [stopMark, stopSpace] = burstPairs[49];
    if (!(stopMark >= 300 && stopMark <= 700 && (stopSpace === 0 || stopSpace >= 4000))) {
      return null;
    }

    const [b0, b1, b2, b3, b4, b5] = bytes as [number, number, number, number, number, number];

    // Validate Panasonic manufacturer code (0x40, 0x04). Frames with other
    // OEM bytes belong to a different Kaseikyo-family protocol (e.g. JVC-48
    // with OEM 3/1).  Compare against the accumulated (bit-reversed) forms
    // because the bytes here were collected LSB-first from the wire.
    if (b0 !== reverseBits(MFG_HI) || b1 !== reverseBits(MFG_LO)) return null;

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
    const freqWord = Math.round(1000000.0 / (CARRIER_HZ * 0.241246));
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

    // The trailing mark and long inter-frame space.
    burstPairs.push([usToPulses(432), usToPulses(40000)]);

    const seq1 = burstPairs.length;
    const header = `0000 ${toHex(freqWord, 4)} ${toHex(seq1, 4)} 0000`;
    const payload = burstPairs.map((p) => `${toHex(p[0], 4)} ${toHex(p[1], 4)}`).join(' ');
    return `${header} ${payload}`;
  }
}
