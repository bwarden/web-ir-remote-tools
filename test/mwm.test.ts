import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Converter } from '../src/lib/converter.js';
import { IRCode, dataHex } from '../src/lib/code.js';

// MWM (Disney "Made With Magic" / Glow With The Show) protocol: 2400 bps
// serial over 38 kHz, 3-18 byte frames (24-144 bits) with no header, each
// byte a 417 us start mark + 8 LSB-first data bits (space = 1) + a 417 us
// stop space. The frame length is implied by the message body: command frames
// carry a 4-bit payload length in the high nibble of byte 0 (0x9x/0xFx), and
// show commands open with 0x55 0xAA. Tasmota's "Data" field is the display
// form (the transmitted bytes as-is).
//
// Also covers the Mode2 pulse/space capture format (native to the LIRC mode2
// tool and the MQTT IR test rig's receive topic).

const converter = new Converter();
const here = dirname(fileURLToPath(import.meta.url));

function assertMwm(code: IRCode, dataHexValue: string, bits: number) {
  assert.equal(code.protocol, 'MWM');
  assert.equal(code.bits, bits);
  assert.equal(BigInt(code.data!), BigInt('0x' + dataHexValue));
}

test('MWM decodeRaw sizes the frame from the value width', () => {
  const p = converter.getProtocol('MWM')!;

  assertMwm(p.decodeRaw('0x550808'), '550808', 24);
  assertMwm(p.decodeRaw('0x96190B09088418014D'), '96190B09088418014D', 72);
  assertMwm(p.decodeRaw('0x9C260CD5636B58EE4803D13C070685'), '9C260CD5636B58EE4803D13C070685', 120);

  // A bare 2-byte value still builds a 3-byte (24-bit) frame.
  assertMwm(p.decodeRaw('0x5508'), '5508', 24);

  // 144-bit maximum frame.
  assertMwm(p.decodeRaw('0x' + 'F5'.repeat(18)), 'F5'.repeat(18), 144);

  // Numeric input and the params path feed the same decoder.
  assertMwm(converter.importCode('MWM', 0x550808), '550808', 24);
  assertMwm(converter.importCode('MWM', { data: '0x550808' }), '550808', 24);
  assert.throws(() => p.decodeParams({}), /MWM requires a data value/);
});

test('MWM values round-trip through Pronto', () => {
  const cases: [string, number][] = [
    ['550808', 24],
    ['F00000', 24],
    ['96190B09088418014D', 72],
    ['900F00000000000000', 72],
    ['961800000000000000', 72],
    ['98FDD23500F2010220668B', 88],
    ['9C260CD5636B58EE4803D13C070685', 120],
    ['FF'.repeat(18), 144],
  ];
  for (const [hex, bits] of cases) {
    const orig = converter.importCode('MWM', '0x' + hex);
    const pronto = converter.exportCode(orig, 'Pronto');
    assert.match(pronto, /^0000 006D /, `${hex} carries the 38 kHz frequency word`);
    const back = converter.importFormat('Pronto', pronto)[0];
    assertMwm(back, hex, bits);
  }
});

test('MWM timing decode recovers every validated Tasmota capture', () => {
  const records: { bits: number; data: string; rawData: string }[] = JSON.parse(
    readFileSync(join(here, 'fixtures', 'mwm-tasmota-captures.json'), 'utf8'),
  );
  let matched = 0;
  for (const { bits, data, rawData } of records) {
    const viaTiming = converter.importFormat('Tasmota', rawData)[0];
    assert.equal(viaTiming.protocol, 'MWM', `timing decode identifies ${data} as MWM`);
    assert.equal(viaTiming.bits, bits, `${data} has ${bits} bits`);
    assert.equal(
      viaTiming.data!.toString(16).toUpperCase(),
      data.slice(2).toUpperCase(),
      `${data} roundtrips through timing decode`,
    );
    matched++;
  }
  assert.equal(matched, records.length, `all ${records.length} fixture records decode`);
});

test('Tasmota structured MWM records import by name', () => {
  // No RawData field: structured fields import directly. (A record carrying
  // timings would follow those instead -- they are authoritative.)
  const dump = JSON.stringify({
    Protocol: 'MWM',
    Bits: 24,
    Data: '0x550808',
    Repeat: 0,
  });
  const [code] = converter.importFormat('Tasmota', dump);
  assertMwm(code, '550808', 24);
  assert.equal(code.alias, '0x550808', 'structured MWM aliases to its Data hex');

  const wide = JSON.stringify({ Protocol: 'MWM', Bits: 120, Data: '0x9C260CD5636B58EE4803D13C070685' });
  const [wideCode] = converter.importFormat('Tasmota', wide);
  assertMwm(wideCode, '9C260CD5636B58EE4803D13C070685', 120);
  assert.equal(wideCode.alias, '0x9C260CD5636B58EE4803D13C070685', 'wide Data hex is not truncated');
});

test('Mode2 decode of the rig capture keeps every signal and identifies MWM', () => {
  const text = readFileSync(join(here, '..', 'samples', 'mode2-capture.log'), 'utf8');
  const codes = converter.importFormat('Mode2', text);

  assert.equal(codes.length, 156, '156 messages');
  const counts: Record<string, number> = {};
  for (const code of codes) counts[code.protocol] = (counts[code.protocol] ?? 0) + 1;
  assert.deepEqual(counts, {
    SAMSUNG: 30,
    JVC: 11,
    UNKNOWN: 55,
    NEC: 28,
    SAMSUNG36: 11,
    MWM: 21,
  });

  const widths: Record<number, number> = {};
  for (const code of codes) {
    if (code.protocol === 'MWM') widths[code.bits] = (widths[code.bits] ?? 0) + 1;
  }
  assert.deepEqual(widths, { 72: 14, 96: 2, 104: 1, 112: 2, 120: 2 });

  // Every code keeps its raw timings; the identified MWM signals carry a full
  // frame (the short UNKNOWN fragments are noise captures).
  assert.ok(codes.every((code) => code.timings && code.timings.length >= 2));
  assert.ok(codes.filter((code) => code.protocol === 'MWM').every((code) => code.timings!.length >= 30));
});

test('Mode2 export to re-import roundtrips every code', () => {
  const text = readFileSync(join(here, '..', 'samples', 'mode2-capture.log'), 'utf8');
  const codes = converter.importFormat('Mode2', text);
  const re = converter.importFormat('Mode2', converter.exportCodes('Mode2', codes));

  assert.equal(re.length, codes.length);
  const mwm = codes.filter((code) => code.protocol === 'MWM');
  const reMwm = re.filter((code) => code.protocol === 'MWM');
  assert.equal(reMwm.length, mwm.length, 'all MWM signals survive');
  assert.ok(mwm.every((code) => reMwm.some((other) => other.data === code.data && other.bits === code.bits)));
});

test('Mode2 export writes alternating pulse/space lines ending on a wide space', () => {
  const code = converter.importCode('MWM', '0x550808');
  const text = converter.exportCode(code, 'Mode2');
  const lines = text.trim().split('\n');

  for (let i = 0; i < lines.length; i++) {
    assert.match(lines[i], new RegExp(`^(pulse|space) \\d+$`));
    assert.equal(lines[i].startsWith('pulse'), i % 2 === 0, 'strict alternation starting on a pulse');
  }
  const lastSpace = Number(lines[lines.length - 1].split(' ')[1]);
  assert.ok(lastSpace >= 10000, 'trailing space splits the message on re-import');

  const back = converter.importFormat('Mode2', text)[0];
  assertMwm(back, '550808', 24);
  assert.equal(dataHex(back.data ?? 0), '0x550808');
});

test('Mode2 UNKNOWN signals are preserved rather than dropped', () => {
  const capture = ['pulse 4000', 'space 2000', 'pulse 500', 'space 100000'].join('\n');
  const [code] = converter.importFormat('Mode2', capture);
  assert.equal(code.protocol, 'UNKNOWN');
  assert.equal(code.timings!.length, 4);
});

test('footerless capture recovers the truncated CRC byte via checksum', () => {
  // Transmit 91 0E 0F 1E (golden yellow) received by 179E4E as a RawData that
  // omits the inter-command footer: the CRC byte's final stop space merges
  // invisibly into the gap, leaving a 39-tick (39-bit) signal. The burst
  // pairs below are exactly those 17 runs.
  const pairs: [number, number][] = [
    [465, 370], [1230, 445], [825, 850], [830, 1270], [1730, 365],
    [420, 1670], [1730, 365], [855, 1655], [1255, 0],
  ];
  const p = converter.getProtocol('MWM')!;
  const code = p.decodeTiming(pairs);
  assertMwm(code!, '910E0F1E', 32);
});
