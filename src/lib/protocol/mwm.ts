// MWM (Disney "Made With Magic" / Glow With The Show) protocol handler,
// ported from IRremoteESP8266's sendMWM/decodeMWM (ir_MWM.cpp) and validated
// against the Tasmota captures in samples/tasmota-capture.log.
//
// The signal is 2400 bps serial over a 38 kHz carrier: 1 start bit (mark),
// 8 data bits (space=1, mark=0, LSB-first), 1 stop bit (space), repeated per
// byte with no header, each logical bit one 417 us tick (up to 9 ticks may
// merge into one measured run). Messages are 3-18 bytes (24-144 bits); the
// byte count is implied by the message body: state[0] carries a 4-bit payload
// length in the high nibble for command frames (0x9x/0xFx), and show
// commands open with the 0x55 0xAA signature. Because the decoded state bytes
// are exactly the transmitted bytes, Tasmota's "Data" field is the 
// display form and no byte-order translation applies.

import { IRCode, parseIntBig, toHex } from '../code.js';
import type { BurstPair, DecodeParams, ProtocolHandler } from '../protocol.js';

const kTick = 417; // us per logical bit
const kMaxWidth = 9; // maximum consecutive same-sign ticks per measured run
const kDelta = 150; // +/- us width tolerance, matching IRrecv::match(delta)
const kMaxGap = 20000; // us threshold for an inter-message space
const kFooterGap = 30000; // us inter-command delay, kMWMMinGap
const kMinSamples = 6; // kMWMMinSamples: shortest frame has 3 bytes, >= 2 samples each
const kStateSizeMax = 55; // IRremoteESP8266 state buffer cap
const kMinBits = 24; // kMWMMinBits: 3 bytes
const kMaxBits = 144; // (15 + 3) * 8: the 4-bit payload nibble caps a frame at 18 bytes

const kSpace = 1; // getRCLevel return value for a space
const kMark = 0; // getRCLevel return value for a mark

// CRC-8 (poly 0x8c, MSB-first, init 0), the byte 0 of a 0x9x/0xFx command
// frame. Mirrors crc8 in perl/lib/Protocol/IR/MWMProbe.pm.
function crc8(bytes: number[]): number {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >> 1) ^ 0x8c : crc >> 1;
    }
  }
  return crc & 0xff;
}

// Match a measured width against `expected` within +/- kDelta us, mirroring
// IRrecv::match with zero tolerance and the kMWMDelta margin.
function matchWidth(width: number, expected: number): boolean {
  return width >= expected - kDelta && width <= expected + kDelta;
}

// Consume one logical level from the run-length rawbuf, expanding a measured
// width into up to kMaxWidth ticks of the same signal, exactly like
// IRrecv::getRClevel(kMWMTick, 0, 0, kMWMDelta, kMWMMaxWidth). Advances
// `state` (a { offset, used } cursor) as levels are consumed.
function getRCLevel(rawbuf: number[], state: { offset: number; used: number }): number {
  if (state.offset >= rawbuf.length) return kSpace;
  const width = rawbuf[state.offset];
  // rawbuf alternates mark/space from index 1, so odd indices are marks.
  const val = state.offset % 2 ? kMark : kSpace;
  // A space wider than the max signal gap or the widest run is an
  // inter-message gap: read it as a bare space without consuming it.
  if (val === kSpace && (width > kMaxGap - kDelta || width > kMaxWidth * kTick + kDelta)) {
    return kSpace;
  }
  let avail;
  for (avail = kMaxWidth; avail > 0; avail--) {
    if (matchWidth(width, avail * kTick)) break;
  }
  if (!avail) return -1; // the width matches no whole number of ticks
  state.used++;
  if (state.used >= avail) {
    state.used = 0;
    state.offset++;
  }
  return val;
}

// Decode a rawbuf of absolute timings into the transmitted state bytes.
// Mirrors IRrecv::decodeMWM with strict matching (Tasmota's decoder is
// non-strict and additionally accepts frames whose trailing bytes exceed the
// payload length; the strict length check is what keeps a truncated capture
// from silently decoding). Returns null when the signal is not a well-formed
// MWM message.
function decodeMWM(rawbuf: number[]): { bytes: number[]; bits: number } | null {
  // kMWMMinSamples: a message is >= 3 bytes and a byte has >= 2 samples, so a
  // run-length buffer of 6 entries or fewer cannot hold a full byte. (The
  // firmware guards one tick looser — rawlen <= 6 + start offset — but its
  // captures carry leading-gap and phase noise that never lands on that
  // boundary, and this decoder must also roundtrip the perfectly compressed
  // output of its own encoder, where a 24-bit message can squeeze into 3
  // burst pairs.)
  if (rawbuf.length <= kMinSamples) return null;

  const st = { offset: 1, used: 0 };
  const state: number[] = [];
  let data = 0;
  let frameBits = 0;
  let dataBits = 0;
  let done = false;

  for (; st.offset < rawbuf.length && dataBits < 8 * kStateSizeMax && !done; frameBits++) {
    const level = getRCLevel(rawbuf, st);
    if (level < 0) break; // width matched no tick count
    switch (frameBits % 10) {
      case 0: // Start bit (mark)
        if (level !== kMark) done = true;
        break;
      case 9: // Stop bit (space)
        if (level !== kSpace) return null;
        // dataBits is the count of completed data bits, a multiple of 8 here.
        state[dataBits / 8 - 1] = data & 0xff;
        data = 0;
        break;
      default: // Data bit, LSB-first, space = 1
        data |= (level === kSpace ? 1 : 0) << 8;
        data >>= 1;
        dataBits++;
        break;
    }
  }

  // The message body implies its own length. Command frames carry a payload
  // byte count in the high nibble of bytes[0]; show commands always open with
  // 0x55 0xAA. The show-command signature is rejected only when BOTH first
  // bytes differ from 0x55 0xAA (a 0x550808 show command, say, differs only
  // in the second byte). Returns the frame when length-consistent, else null.
  const validate = (bytes: number[]): { bytes: number[]; bits: number } | null => {
    const bits = bytes.length * 8;
    if (bits < kMinBits || bits > kMaxBits) return null;
    let payload = 0;
    if ((bytes[0] & 0xf0) === 0x90 || (bytes[0] & 0xf0) === 0xf0) {
      payload = bytes[0] & 0x0f;
    } else if (bytes[0] !== 0x55 && bytes[1] !== 0xaa) {
      return null;
    }
    if (bits < (payload + 3) * 8) return null;
    if (payload && bits > (payload + 3) * 8) return null;
    return { bytes, bits };
  };

  // A complete, naturally-consistent frame stands on its own -- e.g. a 3-byte
  // 55 08 08 show capture whose trailing interference must not be folded into
  // a fabricated extra byte.
  const natural = validate(state);
  if (natural) return natural;

  // Footerless capture: Tasmota omits the ~30 ms inter-command gap, and the
  // final byte's stop space (and any trailing 1-bits) ride invisibly inside it,
  // so the signal can end mid-byte with only the stop bit missing. Only when
  // the natural decode came up short, back-fill the remaining space-valued
  // levels and commit the byte -- and accept the result only if the checksum
  // confirms the reconstructed trailing byte.
  if (!done && frameBits % 10 !== 0) {
    while (frameBits % 10 !== 0) {
      if (frameBits % 10 === 9) {
        state.push(data & 0xff);
        data = 0;
        frameBits++;
        break;
      }
      data = (data >> 1) | 0x80; // data bit, space = 1
      frameBits++;
    }
    const recovered = validate(state);
    if (recovered && crc8(state.slice(0, -1)) === state[state.length - 1]) {
      return recovered;
    }
  }

  return null;
}

export class MwmProtocol implements ProtocolHandler {
  readonly name = 'MWM';

  // The decoded state bytes are the transmitted bytes, so Tasmota's "Data"
  // (the display form) is what decodeRaw reads and there is no separate
  // accumulated/DataLSB form to translate.
  readonly lsbIsAccumulated = false;

  // A bundle is the accumulation of two or more length-declared MWM frames
  // (typically a command A, its status companion B, and a repeat A' -- all
  // three self-declare their own byte length in their leading byte, so the
  // stream is walkable without any side information). ``#`` is a value carrier
  // ("0x..." or bare hex) that, when it is the whole value, is split into one
  // IRCode per frame. The first frame returned is the command/decodeRaw frame
  // A, which is what the structured Data field of a Tasmota MWM record
  // normally carries; ``unbundle`` exists so a single structured hex tap can
  // split a real A+B+A' capture into all three of its own frames.
  unbundle(value: string | number | bigint): IRCode[] {
    const val = BigInt(parseIntBig(value));
    if (val < 0n) throw new Error('MWM data must be non-negative');
    // Walk the value as a run of length-declared frames. ``0x9x``/``0xFx``
    // leading nibbles declare n+3 payload bytes (MWM's 3-byte minimum,
    // byte0's low nibble declaring the byte count after the fixed 3-byte
    // header). When the walk cannot land exactly on the value end, the value
    // is a single bare frame (24-bit show / width-based values) and this
    // returns the one IRCode built from the whole value.
    const hex = val.toString(16).padStart(6, '0');
    const nBytes = Math.ceil(hex.length / 2);
    const bytes: number[] = [];
    for (let i = 0; i < nBytes; i++) {
      bytes.push(parseInt(hex.slice(i * 2, i * 2 + 2), 16));
    }
    const frames: number[][] = [];
    let pos = 0;
    while (pos < bytes.length) {
      const header = bytes[pos];
      const declared = (header & 0x0f) + 3;
      if (pos + declared > bytes.length) break; // trailing noise: not a bundle
      const frame = bytes.slice(pos, pos + declared);
      const high = header & 0xf0;
      if (high !== 0x90 && high !== 0xf0) break; // not a length-declared byte
      frames.push(frame);
      pos += declared;
    }
    if (frames.length < 2 || pos !== bytes.length) {
      // Single frame (or a non-length walk): the width-derived frame is the
      // same one decodeRaw's fallback builds -- inline that law here so a
      // single frame never rings unbundle<->decodeRaw.
      const hexDigits = val.toString(16);
      const bits = Math.max(kMinBits, Math.ceil(hexDigits.length / 2) * 8);
      return [new IRCode({ protocol: this.name, bits, data: val })];
    }
    const codes: IRCode[] = [];
    for (const frame of frames) {
      let data = 0n;
      for (const b of frame) data = (data << 8n) | BigInt(b);
      codes.push(new IRCode({ protocol: this.name, bits: frame.length * 8, data }));
    }
    return codes;
  }

  decodeRaw(raw: string | number | bigint): IRCode {
    const val = BigInt(parseIntBig(raw));
    if (val < 0n) throw new Error('MWM data must be non-negative');
    // A structured tap that ingested a whole A+B+A' bundle asks for a single
    // code: the bundle's first frame (A) is the command that decodeRaw
    // returns for the record's Data field.
    const bundled = this.unbundle(val);
    if (bundled.length >= 2) return bundled[0];
    const hexDigits = val.toString(16);
    // The frame length is implied by the value's own width, rounded up to a
    // whole number of bytes with the 3-byte protocol minimum.
    const bits = Math.max(kMinBits, Math.ceil(hexDigits.length / 2) * 8);
    return new IRCode({ protocol: this.name, bits, data: val });
  }

  decodeParams(args: DecodeParams): IRCode {
    if (args.data === undefined || args.data === null || args.data === '') {
      throw new Error('MWM requires a data value');
    }
    return this.decodeRaw(args.data);
  }

  decodeTiming(burstPairs: BurstPair[]): IRCode | null {
    // Flatten the pairs into the run-length rawbuf IRrecv feeds decodeMWM:
    // index 0 is the leading gap, then alternating mark/space.
    const rawbuf: number[] = [0];
    for (const [mark, space] of burstPairs) {
      rawbuf.push(mark, space);
    }
    const decoded = decodeMWM(rawbuf);
    if (!decoded) return null;

    let value = 0n;
    for (const b of decoded.bytes) value = (value << 8n) | BigInt(b);
    return new IRCode({ protocol: this.name, bits: decoded.bits, data: value });
  }

  // Encode the frame: per byte a 417 us start mark, the 8 data bits LSB-first
  // (space = 1) and a 417 us stop space, then the 30000 us inter-command gap.
  // Consecutive same-sign ticks merge into a single measured run.
  toPronto(code: IRCode): string {
    const carrierHz = 38000;
    const freqWord = Math.round(1000000.0 / (carrierHz * 0.241246));
    const periodUs = freqWord * 0.241246;
    const usToPulses = (us: number) => Math.round(us / periodUs);

    const nbytes = Math.max(3, Math.ceil((code.bits || 24) / 8));
    let val = BigInt(code.data ?? 0);
    const bytes: number[] = [];
    for (let i = 0; i < nbytes; i++) {
      bytes.push(Number(val & 0xffn));
      val >>= 8n;
    }
    bytes.reverse(); // most significant byte first

    const flat: number[] = [];
    for (const b of bytes) {
      flat.push(kTick); // start bit (mark)
      for (let i = 0; i < 8; i++) flat.push((b >> i) & 1 ? -kTick : kTick); // space = 1
      flat.push(-kTick); // stop bit (space)
    }
    flat.push(-kFooterGap);

    const merged: number[] = [];
    for (const v of flat) {
      const last = merged[merged.length - 1];
      if (merged.length !== 0 && Math.sign(last) === Math.sign(v)) {
        merged[merged.length - 1] = last + v;
      } else {
        merged.push(v);
      }
    }

    const pairs: BurstPair[] = [];
    for (let i = 0; i < merged.length; i += 2) {
      pairs.push([Math.abs(merged[i]), Math.abs(merged[i + 1] ?? 0)]);
    }

    const seq1 = pairs.length;
    const header = `0000 ${toHex(freqWord, 4)} ${toHex(seq1, 4)} 0000`;
    const payload = pairs
      .map((p) => `${toHex(usToPulses(p[0]), 4)} ${toHex(usToPulses(p[1]), 4)}`)
      .join(' ');
    return `${header} ${payload}`;
  }
}
