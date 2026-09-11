// SAMSUNG protocol handler (32-bit), ported from IR::Protocol::SAMSUNG.
//
// Timing and bit ordering follow IRremoteESP8266 (Copyright David Conran et
// al., GPLv2, https://github.com/crankyoldgit/IRremoteESP8266):
//   kSamsungHdrMark/Space = 8 * 560us, kSamsungBitMark = 560us,
//   kSamsungOneSpace = 3 * 560us, kSamsungZeroSpace = 560us, 32 bits.
// The 32-bit value is transmitted with the most significant byte first and
// each byte LSB-first within, so the value collected from a capture (and
// stored in ->data) matches Tasmota's DataLSB field. The customer (address)
// and command bytes are bit-reversed on the wire.

import { IRCode, bitReverseBytes, parseIntVal, toHex } from '../code.js';
import type { BurstPair, DecodeParams, ProtocolHandler } from '../protocol.js';

function reverseBits(val: number): number {
  let out = 0;
  for (let i = 0; i < 8; i++) {
    out |= ((val >> i) & 1) << (7 - i);
  }
  return out;
}

// Pack customer (address) + command into the transmitted 32-bit value.
function encodeData(addr: number, cmd: number): number {
  const revCustomer = reverseBits(addr & 0xff);
  const revCommand = reverseBits(cmd & 0xff);
  return (
    ((revCommand ^ 0xff) |
      (revCommand << 8) |
      (revCustomer << 16) |
      (revCustomer << 24)) >>> 0
  );
}

export class SamsungProtocol implements ProtocolHandler {
  readonly name = 'SAMSUNG';

  decodeRaw(raw: string | number): IRCode {
    const val = parseIntVal(raw) >>> 0;
    return this.decodeParams({
      address: (val >> 16) & 0xff,
      command: (val >> 8) & 0xff,
    });
  }

  // SAMSUNG's decodeRaw expects the display form (Tasmota Data): the frame
  // bytes are bit-reversed on the wire, so the accumulated value (Tasmota
  // DataLSB) has to be bit-reversed byte by byte to reach the display form.
  decodeByteOrder(raw: string | number, lsb: boolean): IRCode {
    const val = parseIntVal(raw) >>> 0;
    return this.decodeRaw(lsb ? bitReverseBytes(val, 32) : val);
  }

  decodeParams(args: DecodeParams): IRCode {
    const addr = parseIntVal(args.address ?? args.device ?? 0) & 0xff;
    const cmd = parseIntVal(args.command ?? args.function ?? 0) & 0xff;

    return new IRCode({
      protocol: this.name,
      bits: 32,
      address: addr,
      subaddress: -1,
      command: cmd,
      data: encodeData(addr, cmd),
    });
  }

  // Decode microsecond timing pairs into an IRCode, or null when the timing
  // signature does not match.
  decodeTiming(burstPairs: BurstPair[]): IRCode | null {
    if (burstPairs.length < 34) return null; // Header + 32 bits + Stop

    const [hdrMark, hdrSpace] = burstPairs[0];

    // SAMSUNG Header Check: ~4500us mark, ~4500us space
    if (!(hdrMark >= 3800 && hdrMark <= 5200 && hdrSpace >= 3800 && hdrSpace <= 5200)) {
      return null;
    }

    const bytes = [0, 0, 0, 0];
    for (let i = 0; i < 32; i++) {
      const space = burstPairs[i + 1][1];
      // Space ~1680us = 1, ~560us = 0
      const bit = space > 1000 ? 1 : 0;
      bytes[i >> 3] |= bit << (i & 7); // LSB-first
    }

    // Stop bit: a short mark followed by the long trailing space.
    const [stopMark, stopSpace] = burstPairs[33];
    if (!(stopMark >= 350 && stopMark <= 900 && (stopSpace === 0 || stopSpace >= 3000))) return null;

    const [b0, b1, b2, b3] = bytes as [number, number, number, number];

    // Samsung sends the address byte twice and the command byte followed by
    // its one's complement, so the frame bytes read back as addr, addr, cmd,
    // ~cmd. Enforce that structure (matching IRremoteESP8266's strict
    // decodeSAMSUNG compliance checks) so half-header NECx frames, which
    // share the 4512/4512 us header and per-byte LSB-first bit timing but
    // carry a real subaddress byte instead of a repeated address, are not
    // mislabelled as SAMSUNG. The reference decoder reports those as UNKNOWN.
    if (!(b0 === b1 && b2 === (~b3 & 0xff))) return null;

    // Value is transmitted LSB-first per byte, so the first received byte is
    // the most significant byte of the value (matching Tasmota's DataLSB).
    const data = ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;

    return new IRCode({
      protocol: this.name,
      bits: 32,
      address: reverseBits((data >>> 24) & 0xff),
      subaddress: -1,
      command: reverseBits((data >>> 8) & 0xff),
      data,
    });
  }

  toPronto(code: IRCode): string {
    const carrierHz = 38000;
    const freqWord = Math.round(1000000.0 / (carrierHz * 0.241246));
    const periodUs = freqWord * 0.241246;
    const usToPulses = (us: number) => Math.round(us / periodUs);

    const data = encodeData(code.address, code.command);

    // The value is transmitted with the most significant byte first and each
    // byte LSB-first within. The wire bytes are the MSB display form
    // (Tasmota's Data field), which is the per-byte bit reversal of the
    // collected value.
    const msbVal = bitReverseBytes(data, 32);

    const burstPairs: BurstPair[] = [[usToPulses(4480), usToPulses(4480)]];

    for (let i = 31; i >= 0; i--) {
      const bit = (msbVal >>> i) & 1;
      burstPairs.push([usToPulses(560), usToPulses(bit ? 1680 : 560)]);
    }

    burstPairs.push([usToPulses(560), usToPulses(30000)]);

    const seq1 = burstPairs.length;
    const header = `0000 ${toHex(freqWord, 4)} ${toHex(seq1, 4)} 0000`;
    const payload = burstPairs.map((p) => `${toHex(p[0], 4)} ${toHex(p[1], 4)}`).join(' ');
    return `${header} ${payload}`;
  }
}
