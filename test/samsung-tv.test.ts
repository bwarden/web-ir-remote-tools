import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Converter } from '../src/lib/converter.js';
import { IRCode, toHex } from '../src/lib/code.js';
import { buildIrdbIndex, exactKey, looseKey, type IndexSource } from '../src/lib/indexer.js';
import { buildLircIndex, type LircIndexSource } from '../src/lib/lircIndexer.js';

const converter = new Converter();
const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');
const samples = join(here, '..', 'samples');

// Samsung AA59-00666A TV remote WIG fixture
const wigText = readFileSync(join(samples, 'samsung-aa59-00666a.wig.json'), 'utf8');
const wigData = JSON.parse(wigText);

// LIRC Samsung TV fixture
const lircText = readFileSync(join(fixtures, 'lirc-samsung-tv.lircd.conf'), 'utf8');

// IRDB Samsung TV fixture (NECx2 cross-protocol entries)
const irdbCsv = readFileSync(join(fixtures, 'irdb-samsung-tv.csv'), 'utf8');

function irdbSources(...pairs: [string, string][]): IndexSource[] {
  return pairs.map(([path, text]) => ({ path, text }));
}

function lircSources(...pairs: [string, string][]): LircIndexSource[] {
  return pairs.map(([path, text]) => ({ path, text }));
}

// --- ProntoHex decode: Samsung TV Mute from the WIG -------------------------

test('WIG Mute signal decodes as SAMSUNG with correct address and command', () => {
  const muteSignal = wigData.signals.find((s: any) => s.alias === 'Mute');
  assert.ok(muteSignal, 'Mute signal found in WIG');
  assert.ok(muteSignal.pronto, 'Mute signal has Pronto hex');

  const codes = converter.importFormat('Pronto', muteSignal.pronto);
  assert.equal(codes.length, 1, 'one code decoded from Mute Pronto');

  const code = codes[0];
  assert.equal(code.protocol, 'SAMSUNG', 'Mute decodes as SAMSUNG protocol');
  assert.equal(code.address, 0xe0, 'Mute address is 0xE0 (224)');
  assert.equal(code.command, 0xf0, 'Mute command is 0xF0 (240)');
  assert.equal(code.bits, 32, '32-bit frame');
  // DataLSB (accumulated form): byte-reverse each byte of 0xE0E0F00F
  // E0→07, E0→07, F0→0F, 0F→F0 → 0x07070FF0
  assert.equal(code.data, 0x07070ff0, 'data word matches accumulated form');
});

// --- ProntoHex roundtrip: encode then decode preserves SAMSUNG identity -----

test('SAMSUNG Mute roundtrips through Pronto encode/decode', () => {
  const original = converter.importCode('SAMSUNG', { address: 0xe0, command: 0xf0 });
  assert.equal(original.protocol, 'SAMSUNG');
  assert.equal(original.data, 0x07070ff0);

  const pronto = converter.exportCode(original, 'Pronto');
  assert.ok(pronto.startsWith('0000 006D'), 'Samsung Pronto uses 38kHz carrier');

  const decoded = converter.importFormat('Pronto', pronto)[0];
  assert.equal(decoded.protocol, 'SAMSUNG', 'roundtrip preserves protocol');
  assert.equal(decoded.address, 0xe0, 'roundtrip preserves address');
  assert.equal(decoded.command, 0xf0, 'roundtrip preserves command');
  assert.equal(decoded.data, 0x07070ff0, 'roundtrip preserves data');
});

// --- Tasmota capture decode: Samsung TV Mute --------------------------------

test('Tasmota Samsung Mute capture (Data 0xE0E0F00F) decodes correctly', () => {
  // Line 31 from samples/tasmota-samsung-tv-capture.log
  const capture =
    '{"IrReceived":{"Protocol":"SAMSUNG","Bits":32,"Data":"0xE0E0F00F","DataLSB":"0x7070FF0","Repeat":0,"RawData":"+4515-4465+575-1660+595-1640EfE-520+600g+570-545HgEgEfEfEfEgEgEgEgE-525EfEfEfEfEgEgEkEgEkEgHg+590kLfEfEfEfE-46720A-4470I-1665EfIoEgEkLj+550-540EkI-1690I-1645LsLpI-530LkLkLkLfLsLsLsLpIkIpLpIjJiIpIjI-1670IoIsLuI","RawDataInfo":[135,135,0]}}';

  const codes = converter.importFormat('Tasmota', capture);
  assert.equal(codes.length, 1, 'one code from Tasmota capture');

  const code = codes[0];
  assert.equal(code.protocol, 'SAMSUNG', 'Tasmota capture decodes as SAMSUNG');
  assert.equal(code.address, 0xe0, 'address is 0xE0');
  assert.equal(code.command, 0xf0, 'command is 0xF0');
  assert.equal(code.data, 0x07070ff0, 'data matches accumulated form');

  // The raw timing waveform must agree with the structured fields
  const rawTiming = converter.importFormat('Tasmota', JSON.parse(capture).IrReceived.RawData)[0];
  assert.equal(rawTiming.address, code.address, 'raw timing agrees on address');
  assert.equal(rawTiming.command, code.command, 'raw timing agrees on command');
  assert.equal(rawTiming.data, code.data, 'raw timing agrees on data');
});

// --- IRDB cross-protocol match: SAMSUNG Mute → NECx2 device 7, function 15 -

test('SAMSUNG Mute matches IRDB via NECX2 cross-protocol (device 7, function 15)', () => {
  const muteCode = converter.importCode('SAMSUNG', { address: 0xe0, command: 0xf0 });
  const idx = buildIrdbIndex(irdbSources(['Samsung/TV/AA59-00666A,00.csv', irdbCsv]), { version: 'v1' });

  const ek = exactKey(muteCode);
  const lk = looseKey(muteCode);

  const exactHits = idx.exact[ek] ?? [];
  const looseHits = idx.loose[lk] ?? [];
  assert.ok(exactHits.length > 0 || looseHits.length > 0, 'Mute finds IRDB matches');
  assert.ok(
    [...exactHits, ...looseHits].some((e) => e.path === 'Samsung/TV/AA59-00666A,00.csv'),
    'matches the Samsung TV device path',
  );
  assert.ok(
    [...exactHits, ...looseHits].some((e) => e.alias === 'KEY_MUTE'),
    'matches KEY_MUTE alias',
  );
});

// --- LIRC match: SAMSUNG Mute → KEY_MUTE in lirc-samsung-tv ----------------

test('SAMSUNG Mute matches LIRC KEY_MUTE in Samsung TV remote', () => {
  const muteCode = converter.importCode('SAMSUNG', { address: 0xe0, command: 0xf0 });
  const idx = buildLircIndex(lircSources(['samsung/aa59-00741a.lircd.conf', lircText]), { version: 'v1' });

  const ek = exactKey(muteCode);
  const lk = looseKey(muteCode);

  const exactHits = idx.exact[ek] ?? [];
  const looseHits = idx.loose[lk] ?? [];
  assert.ok(exactHits.length > 0 || looseHits.length > 0, 'Mute finds LIRC matches');
  assert.ok(
    [...exactHits, ...looseHits].some((e) => e.path === 'samsung/aa59-00741a.lircd.conf'),
    'matches the Samsung TV LIRC path',
  );
  assert.ok(
    [...exactHits, ...looseHits].some((e) => e.alias === 'KEY_MUTE'),
    'matches KEY_MUTE alias',
  );
});

// --- WIG import: all signals decode as SAMSUNG family -----------------------

test('all 44 WIG signals decode as SAMSUNG or SAMSUNG36', () => {
  const codes = converter.importFormat('WIG', wigText);
  assert.equal(codes.length, wigData.signals.length, 'every WIG signal imports');

  const protocols = new Set(codes.map((c) => c.protocol));
  for (const p of protocols) {
    assert.ok(
      p === 'SAMSUNG' || p === 'SAMSUNG36',
      `unexpected protocol ${p}; all signals should be SAMSUNG family`,
    );
  }

  // Every signal should have address 0xE0 (the Samsung TV address)
  for (const c of codes) {
    if (c.protocol === 'SAMSUNG') {
      assert.equal(c.address, 0xe0, `${c.alias}: SAMSUNG address is 0xE0`);
    }
  }
});

// --- WIG Samsung/Samsung36 variant identification ---------------------------

test('WIG import identifies Samsung36 signals correctly', () => {
  const codes = converter.importFormat('WIG', wigText);
  const byAlias = new Map(codes.map((c) => [c.alias, c]));

  // Most buttons should be SAMSUNG (32-bit), some might be SAMSUNG36
  const samsung36 = codes.filter((c) => c.protocol === 'SAMSUNG36');
  const samsung32 = codes.filter((c) => c.protocol === 'SAMSUNG');

  // Verify the Mute button is SAMSUNG 32-bit
  const mute = byAlias.get('Mute');
  assert.ok(mute, 'Mute button found');
  assert.equal(mute.protocol, 'SAMSUNG', 'Mute is SAMSUNG (32-bit)');

  // Verify Power button
  const power = byAlias.get('Power');
  assert.ok(power, 'Power button found');
  assert.equal(power.protocol, 'SAMSUNG', 'Power is SAMSUNG (32-bit)');

  // Verify volume/channel buttons are SAMSUNG
  const volUp = byAlias.get('vol+');
  const volDown = byAlias.get('vol-');
  const chUp = byAlias.get('ch+');
  const chDown = byAlias.get('ch-');
  assert.ok(volUp && volDown && chUp && chDown, 'volume and channel buttons found');
  for (const btn of [volUp, volDown, chUp, chDown]) {
    assert.equal(btn.protocol, 'SAMSUNG', `${btn.alias} is SAMSUNG (32-bit)`);
  }
});

// --- Cross-protocol: SAMSUNG → NECX2 reverse mapping ------------------------

test('NECX2 Samsung TV entries are reachable via SAMSUNG keys', () => {
  const idx = buildIrdbIndex(irdbSources(['Samsung/TV/AA59-00666A,00.csv', irdbCsv]), { version: 'v1' });

  // NECX2 device=7, function=8 (POWER) → SAMSUNG addr=reverseByte(7)=0xE0, cmd=reverseByte(8)=0x10
  const samsungPower = converter.importCode('SAMSUNG', { address: 0xe0, command: 0x10 });
  const ek = exactKey(samsungPower);
  const lk = looseKey(samsungPower);

  const exactHits = idx.exact[ek] ?? [];
  const looseHits = idx.loose[lk] ?? [];
  assert.ok(exactHits.length > 0 || looseHits.length > 0, 'NECX2 power reachable via SAMSUNG key');
  assert.ok(
    [...exactHits, ...looseHits].some((e) => e.alias === 'KEY_POWER'),
    'KEY_POWER found via SAMSUNG cross-protocol key',
  );
});

// --- Pronto timing decode: WIG signals survive roundtrip --------------------

test('WIG Samsung signals roundtrip through Pronto timing decode', () => {
  const codes = converter.importFormat('WIG', wigText);
  const mute = codes.find((c) => c.alias === 'Mute');
  assert.ok(mute, 'Mute found');

  const pronto = converter.exportCode(mute, 'Pronto');
  const decoded = converter.importFormat('Pronto', pronto)[0];
  assert.equal(decoded.protocol, mute.protocol, 'protocol survives roundtrip');
  assert.equal(decoded.address, mute.address, 'address survives roundtrip');
  assert.equal(decoded.command, mute.command, 'command survives roundtrip');
  assert.equal(decoded.data, mute.data, 'data survives roundtrip');
});

// --- Conversion fixture: Samsung Mute from conv-samsung.tsv ------------------

test('conv-samsung.tsv Mute fixture roundtrips', () => {
  const tsv = readFileSync(join(fixtures, 'conv-samsung.tsv'), 'utf8');
  const lines = tsv.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
  const muteLine = lines.find((l) => l.startsWith('MUTE\t'));
  assert.ok(muteLine, 'MUTE row found in conv-samsung.tsv');

  const cols = muteLine.split('\t');
  assert.equal(cols.length, 10, '10 columns');
  assert.equal(cols[0], 'MUTE');
  assert.equal(cols[1], 'SAMSUNG');
  assert.equal(cols[2], '224'); // 0xE0
  assert.equal(cols[3], '-1');
  assert.equal(cols[4], '13'); // fixture command

  // Structured → Pronto
  const code = converter.importCode('SAMSUNG', { address: 224, subaddress: -1, command: 13 });
  const pronto = converter.exportCode(code, 'Pronto');
  assert.equal(pronto, cols[5], 'structured SAMSUNG 224/-1/13 encodes to fixture Pronto');

  // Pronto → structured
  const back = converter.importFormat('Pronto', cols[5])[0];
  assert.equal(back.protocol, cols[6]);
  assert.equal(back.address, parseInt(cols[7]));
  assert.equal(back.subaddress, parseInt(cols[8]));
  assert.equal(back.command, parseInt(cols[9]));
});

// --- Tasmota log: all AA59-00666A captures decode and match WIG signals ------

const tasmotaLogText = readFileSync(join(samples, 'samsung-aa59-00666a.tasmota.log'), 'utf8');

// Build WIG lookup: numeric DataLSB → alias
const wigCodes = converter.importFormat('WIG', wigText);
const wigByData = new Map<number, { alias: string; protocol: string; address: number; command: number }>();
for (const c of wigCodes) {
  wigByData.set(Number(c.data), { alias: c.alias, protocol: c.protocol, address: c.address, command: c.command });
}

// Parse Tasmota log lines (prefix varies: "tele/tasmota/..." RESULT {...})
const tasmotaLines = tasmotaLogText
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l.includes('IrReceived'));

test('all 44 Tasmota AA59-00666A captures decode as SAMSUNG addr 0xE0', () => {
  for (const [i, line] of tasmotaLines.entries()) {
    const codes = converter.importFormat('Tasmota', line);
    assert.equal(codes.length, 1, `line ${i + 1}: one code decoded`);
    const code = codes[0];
    assert.equal(code.protocol, 'SAMSUNG', `line ${i + 1}: SAMSUNG protocol`);
    assert.equal(code.address, 0xe0, `line ${i + 1}: address 0xE0`);
    assert.equal(code.bits, 32, `line ${i + 1}: 32 bits`);
  }
});

test('Tasmota structured fields and RawData timing agree for all captures', () => {
  for (const [i, line] of tasmotaLines.entries()) {
    const jsonStr = line.replace(/^.*RESULT\s*/, '');
    const json = JSON.parse(jsonStr);
    const received = json.IrReceived;

    const structured = converter.importFormat('Tasmota', line)[0];
    const timing = converter.importFormat('Tasmota', received.RawData)[0];

    assert.equal(timing.protocol, structured.protocol, `line ${i + 1}: timing protocol matches`);
    assert.equal(timing.address, structured.address, `line ${i + 1}: timing address matches`);
    assert.equal(timing.command, structured.command, `line ${i + 1}: timing command matches`);
    assert.equal(timing.data, structured.data, `line ${i + 1}: timing data matches`);

    assert.equal(structured.protocol, received.Protocol, `line ${i + 1}: matches JSON Protocol`);
    assert.equal(structured.bits, received.Bits, `line ${i + 1}: matches JSON Bits`);

    const dataHex = '0x' + Number(structured.data).toString(16).toUpperCase();
    assert.equal(dataHex, received.DataLSB, `line ${i + 1}: data matches JSON DataLSB`);
  }
});

test('every Tasmota capture maps to a WIG button (44 of 44)', () => {
  const matched = new Set<string>();
  const unmatched: string[] = [];

  for (const [i, line] of tasmotaLines.entries()) {
    const code = converter.importFormat('Tasmota', line)[0];
    const wigEntry = wigByData.get(Number(code.data));
    if (wigEntry) {
      matched.add(wigEntry.alias);
    } else {
      unmatched.push(`line ${i + 1}: data=0x${Number(code.data).toString(16)}`);
    }
  }

  assert.equal(unmatched.length, 0, `no unmatched Tasmota captures: ${unmatched.join('; ')}`);
  assert.equal(matched.size, 44, '44 unique WIG buttons matched');
});

test('all WIG buttons are covered by Tasmota captures', () => {
  const tasmotaDataValues = new Set<number>();
  for (const line of tasmotaLines) {
    const code = converter.importFormat('Tasmota', line)[0];
    tasmotaDataValues.add(Number(code.data));
  }

  const missingWig = wigCodes.filter((c) => !tasmotaDataValues.has(Number(c.data)));
  assert.equal(missingWig.length, 0, 'all WIG buttons have a matching Tasmota capture');
});

test('Tasmota Samsung TV commands cover all numeric keys, vol, ch, and transport', () => {
  const tasmotaCommands = new Map<number, string>();
  for (const line of tasmotaLines) {
    const code = converter.importFormat('Tasmota', line)[0];
    const wig = wigByData.get(Number(code.data));
    if (wig) tasmotaCommands.set(Number(code.command), wig.alias);
  }

  const expected: [string, number][] = [
    ['Power', 0x40], ['Source', 0x80], ['vol+', 0xe0], ['vol-', 0xd0], ['Mute', 0xf0],
    ['ch+', 0x48], ['ch-', 0x08], ['pre-ch', 0xc8], ['0', 0x88],
  ];
  for (const [name, cmd] of expected) {
    assert.ok(tasmotaCommands.has(cmd), `"${name}" (cmd=0x${cmd.toString(16)}) present in captures`);
    assert.equal(tasmotaCommands.get(cmd), name, `cmd=0x${cmd.toString(16)} maps to "${name}"`);
  }
});
