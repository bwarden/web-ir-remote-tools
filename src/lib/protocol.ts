import type { IRCode } from './code.js';

// Discrete parameters a protocol can decode, mirroring the argument names
// IRDB CSV rows and the Perl decode_params methods accept.
export interface DecodeParams {
  address?: string | number;
  device?: string | number;
  subaddress?: string | number;
  subdevice?: string | number;
  command?: string | number;
  function?: string | number;
  data?: string | number | bigint;
}

// A [mark_us, space_us] timing pair, the wire-level unit the timing
// decoders work from.
export type BurstPair = [number, number];

export interface ProtocolHandler {
  readonly name: string;
  // `bigint` in the accepted raw values: MWM frames can be up to 144 bits,
  // beyond the JS safe integer range.
  decodeRaw(raw: string | number | bigint): IRCode;
  decodeParams(args: DecodeParams): IRCode;
  decodeTiming(burstPairs: BurstPair[]): IRCode | null;
  toPronto(code: IRCode): string;

  // Decode a transmitted frame value expressed in a specific byte order.
  // `lsb` selects the accumulated form (Tasmota DataLSB, the IRRemoteESP8266
  // value, the "LSB" column of the sample code tables): each byte is the
  // bit-reversal of the corresponding display byte. `false` selects the
  // display form (Tasmota Data, the "Code"/"MSB" column). Handlers whose
  // decodeRaw agrees with the accumulated form translate the display form to
  // it (and vice versa); a protocol that reports no byte-order distinction
  // omits this and the caller falls back to decodeRaw.
  decodeByteOrder?(raw: string | number, lsb: boolean): IRCode;

  // Whether Tasmota's "DataLSB" — the per-byte bit reversal of the
  // IRRemoteESP8266 `value` — is the accumulated form decodeRaw reads. True
  // for protocols that transmit per-byte LSB-first (NEC, JVC, SAMSUNG).
  // False for whole-word MSB-first protocols such as SAMSUNG36, where
  // DataLSB is a display artifact and the Data field itself must be used.
  readonly lsbIsAccumulated?: boolean;

  // Protocols that may ingest a whole accumulated A+B+A' bundle in a single
  // structured hex tap provide this to split it back into its own frames.
  // Absent for single-frame protocols. The tasmota decodeDump path unwraps
  // a bundled structured record here so every frame is yielded, instead of
  // sinking the whole bundle into one IRCode.
  unbundle?(value: string | number | bigint): IRCode[];
}
