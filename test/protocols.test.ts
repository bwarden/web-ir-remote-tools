import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Converter } from '../src/lib/converter.js';
import { bitReverseBytes } from '../src/lib/code.js';
import { Nec2Protocol, Necx1Protocol, Necx2Protocol } from '../src/lib/protocol/nec.js';
import { JvcProtocol } from '../src/lib/protocol/jvc.js';
import { SamsungProtocol } from '../src/lib/protocol/samsung.js';
import { Samsung36Protocol } from '../src/lib/protocol/samsung36.js';
import { PanasonicProtocol } from '../src/lib/protocol/panasonic.js';

const converter = new Converter();

// Convert Pronto hex tokens to a microsecond burst-pair array, mirroring the
// Perl test helper pronto_to_pairs().
function prontoToPairs(pronto: string): [number, number][] {
  const tokens = pronto.trim().split(/\s+/);
  const freqWord = parseInt(tokens[1], 16);
  const carrier = Math.trunc(1000000.0 / (freqWord * 0.241246));
  const period = 1000000.0 / carrier;
  const pairCount = parseInt(tokens[2], 16) + parseInt(tokens[3], 16);
  const pairs: [number, number][] = [];
  for (let i = 0; i < pairCount; i++) {
    const idx = 4 + i * 2;
    pairs.push([parseInt(tokens[idx], 16) * period, parseInt(tokens[idx + 1], 16) * period]);
  }
  return pairs;
}

test('NEC decode_raw and decode_params', () => {
  const raw = converter.getProtocol('NEC')!.decodeRaw('0x10EF00FF');
  assert.equal(raw.protocol, 'NEC');
  assert.equal(raw.bits, 32);
  assert.equal(raw.address, 0x10);
  assert.equal(raw.subaddress, -1);
  assert.equal(raw.command, 0x00);
  assert.equal(raw.data, 0x10ef00ff);

  const params = converter.getProtocol('NEC')!.decodeParams({ address: 4, subaddress: 0, command: 8 });
  assert.equal(params.address, 4);
  assert.equal(params.subaddress, 0);
  assert.equal(params.command, 8);
  assert.equal(params.data, 0x040008f7);

  const pronto = converter.exportCode(raw, 'Pronto');
  assert.match(pronto, /^0000 006D/, 'Pronto header carries 38 kHz frequency word');

  const back = converter.importFormat('Pronto', pronto)[0];
  assert.equal(back.protocol, 'NEC', 'decode_timing identifies NEC');
  assert.equal(back.data, raw.data, 'timing roundtrip preserves data');

  // A frame with NEC's header but a corrupt stop bit must be rejected rather
  // than misidentified.
  const pairs = prontoToPairs(pronto);
  const shortMark = pairs.slice();
  shortMark[33] = [100, 30000];
  assert.equal(
    converter.getProtocol('NEC')!.decodeTiming(shortMark),
    null,
    'rejects stop bit with too-short mark',
  );

  const shortSpace = pairs.slice();
  shortSpace[33] = [560, 500];
  assert.equal(
    converter.getProtocol('NEC')!.decodeTiming(shortSpace),
    null,
    'rejects stop bit with too-short trailing space',
  );
});

test('NEC2, NECX1, NECX2 variants pack D:S:F:~F with the right defaults', () => {
  const n2 = new Nec2Protocol();

  const withSub = n2.decodeParams({ address: 26, subdevice: 232, command: 5 });
  assert.equal(withSub.protocol, 'NEC2');
  assert.equal(withSub.bits, 32);
  assert.equal(withSub.subaddress, 232);
  assert.equal(withSub.data, 0x1ae805fa, 'NEC2 packs D:S:F:~F');

  const noSub = n2.decodeParams({ address: 26, command: 5 });
  assert.equal(noSub.subaddress, -1, 'NEC2 omitted subaddress defaults to -1');
  assert.equal(noSub.data, 0x1ae505fa, 'NEC2 packs with S=~D');

  const x1 = converter.getProtocol('NECX1')!;
  const x1a = x1.decodeParams({ address: 162, subdevice: 162, command: 1 });
  assert.equal(x1a.protocol, 'NECX1');
  assert.equal(x1a.bits, 32);
  assert.equal(x1a.subaddress, 162);
  assert.equal(x1a.data, 0xa2a201fe, 'NECX1 packs D:S:F:~F with S=D');

  const x1b = x1.decodeParams({ address: 162, command: 1 });
  assert.equal(x1b.subaddress, 162, 'NECX1 omitted subaddress copies the address');
  assert.equal(x1b.data, 0xa2a201fe, 'NECX1 packs with S=D');

  const x2 = converter.getProtocol('NECX2')!;
  const x2a = x2.decodeParams({ address: 43510, command: 7 });
  assert.equal(x2a.protocol, 'NECX2');
  assert.equal(x2a.bits, 32);
  assert.equal(x2a.subaddress, 43510 & 0xff, 'NECX2 omitted subaddress copies the address');
  assert.equal(x2a.data, 0xf6f607f8, 'NECX2 packs with S=D');

  // A NECx frame decoded over Pronto comes back as SAMSUNG (the half-header
  // 4500/4500 timing signature), with the same data word; the protocol
  // identity is preserved on the by-name import path instead.
  const viaPronto = converter.importFormat('Pronto', converter.exportCode(x1a, 'Pronto'))[0];
  assert.equal(viaPronto.protocol, 'SAMSUNG', 'NECx frame decodes as SAMSUNG over Pronto');
  assert.equal(viaPronto.data, x1a.data, 'NECx frame data word survives Pronto roundtrip');
});

test('NECX1 roundtrips an NEC1-style Tasmota capture as NEC', () => {
  const x1 = new Necx1Protocol().decodeParams({ address: 0x10, subdevice: 0xef, command: 0x00 });
  assert.equal(x1.subaddress, 0xef, 'explicit subaddress kept');
  assert.equal(x1.data, 0x10ef00ff, 'packs D:S:F:~F');
});

test('NECX1 with a distinct subaddress is not mislabelled SAMSUNG', () => {
  // NECx frames share Samsung's 4500/4500 us half header and per-byte LSB-first
  // bit timing, but carry a real subaddress byte where Samsung repeats the
  // address. Samsung's strict decoder must reject the frame (IRremoteESP8266
  // does the same and reports it UNKNOWN) so the NECX1 decoder can name it.
  const x1 = new Necx1Protocol().decodeParams({ address: 0x10, subaddress: 0xef, command: 0x00 });
  assert.notEqual(x1.subaddress, x1.address, 'subaddress differs from address');

  const viaPronto = converter.importFormat('Pronto', converter.exportCode(x1, 'Pronto'))[0];
  assert.equal(viaPronto.protocol, 'NECX1', 'NECx frame keeps its NECX1 identity on a timing decode');
  assert.equal(viaPronto.address, 0x10, 'address survives the timing roundtrip');
  assert.equal(viaPronto.subaddress, 0xef, 'subaddress survives the timing roundtrip');
  assert.equal(viaPronto.command, 0x00, 'command survives the timing roundtrip');

  // SAMSUNG's decoder on the same frame must decline: its byte structure
  // check needs address/address/command/~command, which this frame lacks.
  const pairs = prontoToPairs(converter.exportCode(x1, 'Pronto'));
  assert.equal(new SamsungProtocol().decodeTiming(pairs), null,
    'SAMSUNG strict decoder rejects the NECx frame');
});

test('JVC decode_raw, decode_params, and Pronto roundtrip', () => {
  const jvc = new JvcProtocol();
  const raw = jvc.decodeRaw('0x030C');
  assert.equal(raw.protocol, 'JVC');
  assert.equal(raw.bits, 16);
  assert.equal(raw.address, 3);
  assert.equal(raw.subaddress, -1);
  assert.equal(raw.command, 12);
  assert.equal(raw.data, 0x030c);

  const params = jvc.decodeParams({ address: 3, command: 12 });
  assert.equal(params.data, 0x030c, 'params pack into the same data word');

  const pronto = converter.exportCode(raw, 'Pronto');
  assert.match(pronto, /^0000 006D/, 'Pronto header carries 38 kHz frequency word');

  const back = converter.importFormat('Pronto', pronto)[0];
  assert.equal(back.protocol, 'JVC', 'decode_timing identifies JVC');
  assert.equal(back.data, raw.data, 'timing roundtrip preserves data');

  // A frame with JVC's header but a corrupt stop bit must be rejected.
  const pairs = prontoToPairs(pronto);
  const bad = pairs.slice();
  bad[17] = [100, 1000];
  assert.equal(new JvcProtocol().decodeTiming(bad), null, 'rejects corrupt stop bit');
});

test('SAMSUNG decode_raw, wire value semantics, and roundtrip', () => {
  const samsung = new SamsungProtocol();

  const raw = samsung.decodeRaw('0xE0E040BF');
  assert.equal(raw.protocol, 'SAMSUNG');
  assert.equal(raw.bits, 32);
  assert.equal(raw.address, 0xe0);
  assert.equal(raw.subaddress, -1);
  assert.equal(raw.command, 0x40);
  assert.equal(raw.data, 0x070702fd, 'data is the LSB-first collected value (DataLSB)');

  const params = samsung.decodeParams({ address: 0xe0, command: 0x40 });
  assert.equal(params.address, 0xe0);
  assert.equal(params.command, 0x40);
  assert.equal(params.data, 0x070702fd, 'params pack into the same data word');

  const params2 = samsung.decodeParams({ address: 4, command: 0xff });
  assert.equal(params2.address, 4, 'device alias maps to address');
  assert.equal(params2.command, 0xff);
  assert.equal(params2.data, 0x2020ff00, 'data packs customer/command');

  const pronto = converter.exportCode(params, 'Pronto');
  assert.match(pronto, /^0000 006D/, 'Pronto header carries 38 kHz frequency word');
  const tokens = pronto.trim().split(/\s+/);
  assert.equal(parseInt(tokens[2], 16), 34, 'sequence1 carries header + 32 bits + stop');

  const back = converter.importFormat('Pronto', pronto)[0];
  assert.equal(back.protocol, 'SAMSUNG', 'decode_timing identifies SAMSUNG');
  assert.equal(back.data, params.data, 'timing roundtrip preserves data');
  assert.equal(back.address, 0xe0, 'timing roundtrip preserves address');
  assert.equal(back.command, 0x40, 'timing roundtrip preserves command');

  for (const [addr, cmd] of [
    [0x04, 0xff],
    [0x12, 0x56],
    [0xe0, 0x19],
    [0x00, 0x00],
  ]) {
    const code = converter.importCode('SAMSUNG', { address: addr, command: cmd });
    const rt = converter.importFormat('Pronto', converter.exportCode(code, 'Pronto'))[0];
    assert.equal(rt.data, code.data, `SAMSUNG ${addr.toString(16)}/${cmd.toString(16)} data survives roundtrip`);
    assert.equal(rt.address, addr, `SAMSUNG ${addr.toString(16)}/${cmd.toString(16)} address survives roundtrip`);
    assert.equal(rt.command, cmd, `SAMSUNG ${addr.toString(16)}/${cmd.toString(16)} command survives roundtrip`);
  }

  // Stop-bit rejection: right header, corrupt stop bit.
  const timings = prontoToPairs(pronto);
  const shortMark = timings.slice();
  shortMark[33] = [100, 30000];
  assert.equal(samsung.decodeTiming(shortMark), null, 'rejects stop bit with too-short mark');
  const shortSpace = timings.slice();
  shortSpace[33] = [560, 500];
  assert.equal(samsung.decodeTiming(shortSpace), null, 'rejects stop bit with too-short trailing space');
});

test('real JVC capture decodes as JVC with DataLSB 0x0317', () => {
  const capture =
    '+8495-4070+660-1440C-1450+620-430+655-390H-400+645-405Ci+650jHeCdC-1445+625-425M-1480OjMjCiC';
  const cap = converter.importFormat('Tasmota', capture)[0];
  assert.equal(cap.protocol, 'JVC', 'real JVC capture decodes as JVC');
  assert.equal(cap.data, 0x0317, 'real JVC capture data matches DataLSB');
  assert.equal(cap.address, 3, 'real JVC capture address');
  assert.equal(cap.command, 23, 'real JVC capture command');
});

test('bitReverseBytes maps the accumulated and display byte orders', () => {
  // NEC sample row 0x20DF906F / 0x04FB09F6 (Vizio TV Mute, address 4, cmd 9).
  assert.equal(bitReverseBytes(0x04fb09f6, 32), 0x20df906f, 'NEC accumulated -> display');
  assert.equal(bitReverseBytes(0x20df906f, 32), 0x04fb09f6, 'NEC display -> accumulated');
  // JVC VCR row 0xC2CC / 0x4333 (button "0", address 0x43, cmd 0x33).
  assert.equal(bitReverseBytes(0x4333, 16), 0xc2cc, 'JVC accumulated -> display');
  assert.equal(bitReverseBytes(0xc2cc, 16), 0x4333, 'JVC display -> accumulated');
  // SAMSUNG capture 0xE0E040BF / 0x070702FD (address 0xE0, cmd 0x40).
  assert.equal(bitReverseBytes(0x070702fd, 32), 0xe0e040bf, 'SAMSUNG accumulated -> display');
  assert.equal(bitReverseBytes(0xe0e040bf, 32), 0x070702fd, 'SAMSUNG display -> accumulated');
});

test('SAMSUNG36 decode_raw, whole-word LSB semantics, and roundtrip', () => {
  const s36 = new Samsung36Protocol();

  // IRremoteESP8266 TestDecodeSamsung36 expectations: value 0x400E00FF
  // carries address 0x400 and command 0xE00FF.
  const raw = s36.decodeRaw('0x400E00FF');
  assert.equal(raw.protocol, 'SAMSUNG36');
  assert.equal(raw.bits, 36);
  assert.equal(raw.address, 0x400);
  assert.equal(raw.subaddress, -1);
  assert.equal(raw.command, 0xe00ff);
  assert.equal(raw.data, 0x400e00ff);

  const params = s36.decodeParams({ address: 0x400, command: 0xe00ff });
  assert.equal(params.data, 0x400e00ff, 'params pack into the same 36-bit word');

  // The LSB column is the whole word reversed end to end, not per byte: the
  // sample row 0x400EBC43 / 0xC23D70020 flips between the two forms.
  assert.equal(s36.decodeByteOrder('0xC23D70020', true).data, 0x400ebc43, 'sample LSB column reverses to the display form');
  assert.equal(s36.decodeByteOrder('0x400ebc43', false).data, 0x400ebc43, 'display form passes through unchanged');

  const viaLsb = converter.importLsb('SAMSUNG36', '0xC23D70020');
  assert.equal(viaLsb.address, 0x400, 'LSB form decodes the same address');
  assert.equal(viaLsb.command, 0xebc43, 'LSB form decodes the same command');
  assert.equal(viaLsb.data, 0x400ebc43);

  const viaMsb = converter.importMsb('SAMSUNG36', '0x400EBC43');
  assert.equal(viaMsb.data, 0x400ebc43);
  assert.equal(viaMsb.command, 0xebc43);

  // Pronto roundtrip: the timing decodes back as SAMSUNG36 (SAMSUNG itself
  // rejects the 36-bit framing, because its stop-bit pair lands on a mid-frame
  // data bit whose space is never 3000 us or more).
  const pronto = converter.exportCode(raw, 'Pronto');
  assert.match(pronto, /^0000 006D/, 'Pronto header carries 38 kHz frequency word');
  const back = converter.importFormat('Pronto', pronto)[0];
  assert.equal(back.protocol, 'SAMSUNG36', 'decode_timing identifies SAMSUNG36');
  assert.equal(back.data, 0x400e00ff, 'timing roundtrip preserves data');
  assert.equal(back.address, 0x400, 'timing roundtrip preserves address');
  assert.equal(back.command, 0xe00ff, 'timing roundtrip preserves command');
});

test('real SAMSUNG36 capture decodes over Tasmota RawData', () => {
  const raw = [
    4542, 4438, 568, 432, 562, 436, 536, 462, 538, 460, 538, 460, 564, 1434,
    564, 434, 534, 464, 536, 462, 562, 436, 536, 464, 564, 432, 538, 462, 536,
    464, 534, 464, 564, 420, 566, 4414, 538, 1462, 566, 1432, 562, 1436, 536,
    462, 564, 436, 562, 436, 560, 436, 562, 436, 562, 436, 560, 438, 536, 462,
    562, 436, 562, 1436, 562, 1434, 536, 1462, 564, 1434, 562, 1436, 564,
    1436, 534, 1462, 534, 1464, 536,
  ];
  const cap = converter.importFormat('Tasmota', raw)[0];
  assert.equal(cap.protocol, 'SAMSUNG36', 'real capture decodes as SAMSUNG36');
  assert.equal(cap.data, 0x400e00ff, 'real capture data matches IRremoteESP8266 value');
  assert.equal(cap.address, 0x400, 'real capture address');
  assert.equal(cap.command, 0xe00ff, 'real capture command');
});

test('importLsb and importMsb decode either byte order to the same command', () => {
  // NEC: decodeRaw expects the accumulated form, so importMsb translates the
  // display form first. Both end at address 4, command 9, data 0x04FB09F6.
  const necLsb = converter.importLsb('NEC', '0x04FB09F6');
  const necMsb = converter.importMsb('NEC', '0x20DF906F');
  for (const code of [necLsb, necMsb]) {
    assert.equal(code.address, 4, 'NEC address from either byte order');
    assert.equal(code.command, 9, 'NEC command from either byte order');
    assert.equal(code.data, 0x04fb09f6, 'NEC data word from either byte order');
  }

  // JVC: same rule. Both end at address 0x43, command 0x33, data 0x4333.
  const jvcLsb = converter.importLsb('JVC', '0x4333');
  const jvcMsb = converter.importMsb('JVC', '0xC2CC');
  for (const code of [jvcLsb, jvcMsb]) {
    assert.equal(code.address, 0x43, 'JVC address from either byte order');
    assert.equal(code.command, 0x33, 'JVC command from either byte order');
    assert.equal(code.data, 0x4333, 'JVC data word from either byte order');
  }

  // SAMSUNG: decodeRaw expects the display form, so importLsb translates the
  // accumulated form first. Both end at address 0xE0, command 0x40.
  const samLsb = converter.importLsb('SAMSUNG', '0x070702FD');
  const samMsb = converter.importMsb('SAMSUNG', '0xE0E040BF');
  for (const code of [samLsb, samMsb]) {
    assert.equal(code.address, 0xe0, 'SAMSUNG address from either byte order');
    assert.equal(code.command, 0x40, 'SAMSUNG command from either byte order');
    assert.equal(code.data, 0x070702fd, 'SAMSUNG data word from either byte order');
  }
});

test('bitReverseBytes handles 48-bit words without truncation', () => {
  // JVC-48 CD player row (OEM 3/1, address 0x22, subaddress 0x21, command 0x03,
  // checksum 0): accumulated 0x030122210300 flips byte-by-byte to display
  // 0xC0804484C000.
  assert.equal(bitReverseBytes(0x030122210300, 48), 0xc0804484c000, 'JVC-48 accumulated -> display');
  assert.equal(bitReverseBytes(0xc0804484c000, 48), 0x030122210300, 'JVC-48 display -> accumulated');
  // Hokkaido AC 48-NEC2 row (address 0x4D, subaddress 0xB2, command 0xDE, ~F
  // 0x21, E 0x00, ~E 0xFF).
  assert.equal(bitReverseBytes(0x4db2de2100ff, 48), 0xb24d7b8400ff, '48-NEC accumulated -> display');
  assert.equal(bitReverseBytes(0xb24d7b8400ff, 48), 0x4db2de2100ff, '48-NEC display -> accumulated');
});

test('JVC-48 decode_params, byte orders, and roundtrip', () => {
  const j48 = converter.getProtocol('JVC-48')!;

  // IRDB JVC CD Player row (device 34, subdevice 33, function 3).
  const params = j48.decodeParams({ address: 34, subaddress: 33, command: 3 });
  assert.equal(params.protocol, 'JVC-48');
  assert.equal(params.bits, 48);
  assert.equal(params.subaddress, 33);
  assert.equal(params.data, 0x030122210300, 'packs OEM 3/1 then D:S:F:checksum');

  const omitsSub = j48.decodeParams({ address: 34, command: 3 });
  assert.equal(omitsSub.subaddress, -1, 'omitted subaddress stays -1');
  assert.equal(omitsSub.data, 0x30122000321, 'wire subdevice defaults to 0');

  const lsb = converter.importLsb('JVC-48', '0x030122210300');
  assert.equal(lsb.address, 34, 'accumulated form decodes the address');
  assert.equal(lsb.subaddress, 33);
  assert.equal(lsb.command, 3);
  const msb = converter.importMsb('JVC-48', '0xC0804484C000');
  assert.equal(msb.data, 0x030122210300, 'display form translates to the accumulated word');

  const pronto = converter.exportCode(params, 'Pronto');
  assert.match(pronto, /^0000 0070/, 'Pronto header carries 37 kHz frequency word');
  const back = converter.importFormat('Pronto', pronto)[0];
  assert.equal(back.protocol, 'JVC-48', 'decode_timing identifies JVC-48');
  assert.equal(back.data, 0x030122210300, 'timing roundtrip preserves the 48-bit word');
  assert.equal(back.address, 34);
  assert.equal(back.subaddress, 33);
  assert.equal(back.command, 3);
});

test('48-NEC decode_params packs D:S:F:~F:E:~E and roundtrips', () => {
  const nec48 = converter.getProtocol('48-NEC2')!;

  // Hokkaido AC row (address 77, subdevice 178, function 222). The E byte is
  // not in the IRDB rows and goes out cleared.
  const params = nec48.decodeParams({ address: 77, subaddress: 178, command: 222 });
  assert.equal(params.protocol, '48-NEC2');
  assert.equal(params.bits, 48);
  assert.equal(params.address, 77);
  assert.equal(params.subaddress, 178);
  assert.equal(params.command, 222);
  assert.equal(params.data, 0x4db2de2100ff, 'packs D:S:F:~F:E:~E');

  const viaLsb = converter.importLsb('48-NEC2', '0x4DB2DE2100FF');
  assert.equal(viaLsb.address, 77);
  assert.equal(viaLsb.subaddress, 178);
  assert.equal(viaLsb.command, 222);
  const viaMsb = converter.importMsb('48-NEC2', '0xB24D7B8400FF');
  assert.equal(viaMsb.data, 0x4db2de2100ff, 'display form translates to the accumulated word');

  const viaMsb1 = converter.importMsb('48-NEC1', '0xB24D7B8400FF');
  assert.equal(viaMsb1.protocol, '48-NEC1', '48-NEC1 keeps its identity on by-name import');

  const pronto = converter.exportCode(params, 'Pronto');
  assert.match(pronto, /^0000 006D/, 'Pronto header carries 38 kHz frequency word');
  const back = converter.importFormat('Pronto', pronto)[0];
  // A single frame cannot tell 48-NEC1 from 48-NEC2 (they share the framing
  // and differ only in repeat structure), so the base variant absorbs the
  // timing decode just as NEC absorbs NEC2.
  assert.equal(back.protocol, '48-NEC1', 'decode_timing identifies the 48-bit NEC framing');
  assert.equal(back.data, 0x4db2de2100ff, 'timing roundtrip preserves the 48-bit word');
  assert.equal(back.address, 77);
  assert.equal(back.subaddress, 178);
  assert.equal(back.command, 222);
});

test('PANASONIC decode_params, byte orders, and roundtrip', () => {
  const pan = new PanasonicProtocol();

  // IRDB convention: wire device 0x01 → address 128 (0x80), wire cmd 0xBC → command 0x3D.
  // Data is the accumulated form (per-byte bit-reversed wire bytes).
  const params = pan.decodeParams({ address: 128, subaddress: 0, command: 0x3d });
  assert.equal(params.protocol, 'PANASONIC');
  assert.equal(params.bits, 48);
  assert.equal(params.address, 128);
  assert.equal(params.subaddress, 0);
  assert.equal(params.command, 0x3d);
  assert.equal(params.data, 0x022080003dbd, 'packs accumulated OEM + D:S:F:checksum');

  const omitsSub = pan.decodeParams({ address: 128, command: 0x33 });
  assert.equal(omitsSub.subaddress, -1, 'omitted subaddress stays -1');
  assert.equal(omitsSub.data, 0x0220800033b3, 'wire subdevice defaults to 0');

  const lsb = converter.importLsb('PANASONIC', '0x022080003DBD');
  assert.equal(lsb.address, 128, 'accumulated form decodes the address');
  assert.equal(lsb.subaddress, 0);
  assert.equal(lsb.command, 0x3d);

  const msb = converter.importMsb('PANASONIC', '0x40040100BCBD');
  assert.equal(msb.data, 0x022080003dbd, 'display form translates to the accumulated word');

  const pronto = converter.exportCode(params, 'Pronto');
  assert.match(pronto, /^0000 0073/, 'Pronto header carries 36 kHz frequency word');
  const back = converter.importFormat('Pronto', pronto)[0];
  assert.equal(back.protocol, 'PANASONIC', 'decode_timing identifies PANASONIC');
  assert.equal(back.data, 0x022080003dbd, 'timing roundtrip preserves the 48-bit word');
  assert.equal(back.address, 128);
  assert.equal(back.subaddress, 0);
  assert.equal(back.command, 0x3d);
});

test('PANASONIC decode_timing rejects JVC-48 OEM codes', () => {
  // A JVC-48 frame must NOT decode as PANASONIC (OEM mismatch).
  const j48 = converter.getProtocol('JVC-48')!;
  const jvcParams = j48.decodeParams({ address: 34, subaddress: 33, command: 3 });
  const pronto = converter.exportCode(jvcParams, 'Pronto');
  const pairs = prontoToPairs(pronto);
  assert.equal(new PanasonicProtocol().decodeTiming(pairs), null,
    'PANASONIC rejects JVC-48 OEM codes 3/1');
});

test('PANASONIC from real Tasmota capture', () => {
  // Line 1: Data 0x40040100BCBD → accumulated 0x022080003DBD (addr=128, cmd=0x3d)
  const capture1 =
    '+3535-1685+515-365+520-1230C-360CgCgEg+540-335H-340Cg+545iHjCgHjC-1235HjHj+510dCdCdCdCdCdCdC-1240MdHjCdCgCdMdMdHjMlCdMlMl+535-1210Ml+530-350OjMnM-370ClMnMnMnO-345MnO';
  const cap1 = converter.importFormat('Tasmota', capture1)[0];
  assert.equal(cap1.protocol, 'PANASONIC', 'real capture 1 decodes as PANASONIC');
  assert.equal(cap1.data, 0x022080003dbd, 'real capture 1 data matches');
  assert.equal(cap1.address, 128, 'real capture 1 address');
  assert.equal(cap1.command, 0x3d, 'real capture 1 command');

  // Line 4: Data 0x40040100CCCD → accumulated 0x0220800033B3
  const capture4 =
    '+3535-1690+515-360+545-1205Cd+520dGdGdE-335+540hE-330GdEjEhI-340C-1235IkC-365CdGdCmIkIkCmCdClCmCmIk+510mC-370NmNmCm+535-1215P-1210NoNmNlN-1240P-345NoNsNsNo+505oNsNsUoU-1245U';
  const cap4 = converter.importFormat('Tasmota', capture4)[0];
  assert.equal(cap4.protocol, 'PANASONIC', 'real capture 4 decodes as PANASONIC');
  assert.equal(cap4.data, 0x0220800033b3, 'real capture 4 data matches');

  // Line 9: Data 0x4004019059C8 → accumulated 0x022080099A13
  // address 0x80 (128), sub 0x09, cmd 0x9A
  const capture9 =
    '+3565-1660+540-335+515-1235E-360+520-355+545dJ-330JkCdJkCdHgJdHgH-1230HgHgEgCdC-340EgCmHgCdElEfEgHgC-1205EgCmCmCmE-365ElCdHlElEoEgC-1210+510fCpEgEoQ-1240EoQoEoC';
  const cap9 = converter.importFormat('Tasmota', capture9)[0];
  assert.equal(cap9.protocol, 'PANASONIC', 'real capture 9 decodes as PANASONIC');
  assert.equal(cap9.data, 0x022080099a13, 'real capture 9 data matches');
  assert.equal(cap9.address, 128, 'real capture 9 address');
  assert.equal(cap9.subaddress, 0x09, 'real capture 9 subaddress');
  assert.equal(cap9.command, 0x9a, 'real capture 9 command');
});

test('SAMSUNG20 decode_params, default subdevice, and roundtrip', () => {
  const s20 = converter.getProtocol('SAMSUNG20')!;

  // IRDB Samsung AC row (device 1, subdevice 8, function 39).
  const params = s20.decodeParams({ address: 1, subaddress: 8, command: 39 });
  assert.equal(params.protocol, 'SAMSUNG20');
  assert.equal(params.bits, 20);
  assert.equal(params.data, 0x27201, 'packs F:8 into the high byte then D:6:S:6');

  const omitsSub = s20.decodeParams({ address: 1, command: 39 });
  assert.equal(omitsSub.subaddress, -1, 'omitted subdevice stays -1');
  assert.equal(omitsSub.data, 0x27001, 'wire subdevice defaults to 0');

  const raw = s20.decodeRaw('0x27201');
  assert.equal(raw.address, 1);
  assert.equal(raw.subaddress, 8);
  assert.equal(raw.command, 39);

  const pronto = converter.exportCode(params, 'Pronto');
  const back = converter.importFormat('Pronto', pronto)[0];
  assert.equal(back.protocol, 'SAMSUNG20', 'decode_timing identifies SAMSUNG20');
  assert.equal(back.data, 0x27201, 'timing roundtrip preserves the 20-bit word');
  assert.equal(back.address, 1);
  assert.equal(back.subaddress, 8);
  assert.equal(back.command, 39);
});
