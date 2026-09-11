import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Converter } from '../src/lib/converter.js';

const converter = new Converter();
const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');

function loadLirc(file: string) {
  return converter.importFormat('LIRC', readFileSync(join(fixtures, file), 'utf8'));
}

// --- Import: Samsung TV remote with pre_data -----------------------------

test('import Samsung LIRC remote', () => {
  const codes = loadLirc('lirc-samsung-tv.lircd.conf');
  assert.ok(codes.length > 0, 'decoded codes from Samsung LIRC file');
  assert.equal(codes.length, 43, '43 buttons in the Samsung remote');

  // Check a known button: KEY_POWER 0x40BF with pre_data 0xE0E0
  const power = codes.find((c) => c.alias === 'KEY_POWER');
  assert.ok(power, 'found KEY_POWER');
  assert.equal(power.protocol, 'SAMSUNG', 'POWER decoded as SAMSUNG');
  // Samsung stores the accumulated (per-byte-reversed) form: 0xE0E040BF → 0x070702FD
  assert.equal(power.data, 0x070702FD, 'POWER data is the accumulated form');

  // Check another button
  const volup = codes.find((c) => c.alias === 'KEY_VOLUMEUP');
  assert.ok(volup, 'found KEY_VOLUMEUP');
  assert.equal(volup.protocol, 'SAMSUNG', 'VOLUMEUP decoded as SAMSUNG');
  // 0xE0E0E01F → per-byte reversed → 0x070707F8
  assert.equal(volup.data, 0x070707F8, 'VOLUMEUP data is the accumulated form');
});

// --- Import: minimal inline LIRC ----------------------------------------

test('import minimal inline LIRC', () => {
  const lirc = `
begin remote
  name  TestNEC
  bits           32
  flags SPACE_ENC|CONST_LENGTH
  eps            30
  aeps          100
  header       9000  4500
  one           560  1690
  zero          560   560
  ptrail        560
  repeat       9000  2250
  gap          108000
  toggle_bit_mask 0x0

      begin codes
          KEY_POWER    0x10EF00FF
          KEY_VOLUP    0x10EF40BF
      end codes
end remote
`;

  const codes = converter.importFormat('LIRC', lirc);
  assert.equal(codes.length, 2, 'decoded 2 NEC buttons');

  assert.equal(codes[0].alias, 'KEY_POWER', 'first button alias');
  assert.equal(codes[0].protocol, 'NEC', 'NEC timing inferred');
  assert.equal(codes[0].data, 0x10EF00FF, 'NEC data from codes section');

  assert.equal(codes[1].alias, 'KEY_VOLUP', 'second button alias');
  assert.equal(codes[1].data, 0x10EF40BF, 'second NEC data');
});

// --- Import: Bose remote (unknown protocol, timing-based decode) ---------

test('import Bose SoundTouch remote', () => {
  const lirc = `
begin remote
  name  BOSE_SOUNDTOUCH
  bits           16
  flags SPACE_ENC|CONST_LENGTH
  eps            30
  aeps          100
  header        941  1553
  one           440  1550
  zero          440   555
  ptrail        438
  gap          77681
  min_repeat      1
  toggle_bit_mask 0x0

      begin codes
          KEY_POWER                0xCD32
          KEY_1                    0x1FE0
          KEY_VOLUMEUP             0x3FC0
          KEY_VOLUMEDOWN           0xBF40
      end codes
end remote
`;

  const codes = converter.importFormat('LIRC', lirc);
  assert.equal(codes.length, 4, 'decoded 4 Bose buttons');
  assert.equal(codes[0].alias, 'KEY_POWER', 'first button alias');
  // Bose timing doesn't match NEC/Samsung/JVC, so it may be UNKNOWN
  assert.ok(codes[0].data !== undefined, 'data is defined');
});

// --- Import: JVC VCR remote with 48-bit hex values ----------------------

test('import JVC VCR LIRC remote', () => {
  const codes = loadLirc('lirc-jvc-vcr.lircd.conf');
  assert.ok(codes.length > 0, 'decoded codes from JVC VCR LIRC file');
  assert.equal(codes.length, 20, '20 buttons in the JVC VCR remote');

  const power = codes.find((c) => c.alias === 'KEY_POWER');
  assert.ok(power, 'found KEY_POWER');
  assert.equal(power.protocol, 'JVC', 'POWER decoded as JVC');
  assert.equal(power.data, 0xC2D0, 'POWER 16-bit data (48-bit hex masked)');

  const play = codes.find((c) => c.alias === 'KEY_PLAY');
  assert.ok(play, 'found KEY_PLAY');
  assert.equal(play.data, 0xC230, 'PLAY data');

  // TV_POWER uses a different device address (0xC0 vs 0xC2)
  const tvPower = codes.find((c) => c.alias === 'TV_POWER');
  assert.ok(tvPower, 'found TV_POWER');
  assert.equal(tvPower.data, 0xC0E8, 'TV_POWER data (different device address)');
});

// --- Import: raw codes ---------------------------------------------------

test('import raw codes LIRC', () => {
  const lirc = `
begin remote
  name  RAW_TEST
  flags RAW_CODES|CONST_LENGTH
  eps            25
  aeps          100
  ptrail          0
  repeat     0     0
  gap    100000

      begin raw_codes
          name Power
               9020  4520  560  560  560  560  560  560
               560  560  560  1690  560  1690  560  1690
               560  560  560  560  560  560  560  560
               560  1690  560  1690  560  560  560  560
               560  560  560  560  560  560  560  560
               560  560  560  560  560  560  560  560
               560  1690  560  1690  560  1690  560  1690
               560  560  560  1690  560  1690  560  1690
               560  1690  560  43310
      end raw_codes
end remote
`;

  const codes = converter.importFormat('LIRC', lirc);
  assert.equal(codes.length, 1, 'decoded 1 raw code');
  assert.equal(codes[0].alias, 'Power', 'raw code alias');
  assert.equal(codes[0].protocol, 'NEC', 'raw NEC timing decoded');
  assert.ok(Array.isArray(codes[0].timings), 'timings preserved');
});

// --- Export: NEC code to LIRC -------------------------------------------

test('export NEC code to LIRC', () => {
  const code = converter.importCode('NEC', '0x10EF00FF');
  code.alias = 'KEY_POWER';

  const lirc = converter.exportCode(code, 'LIRC', { name: 'TestRemote' });
  assert.match(lirc, /begin remote/, 'output has begin remote');
  assert.match(lirc, /name\s+TestRemote/, 'remote name present');
  assert.match(lirc, /bits\s+32/, '32-bit NEC');
  assert.match(lirc, /header\s+9000\s+4500/, 'NEC header timings');
  assert.match(lirc, /one\s+560\s+1690/, 'NEC one timings');
  assert.match(lirc, /zero\s+560\s+560/, 'NEC zero timings');
  assert.match(lirc, /KEY_POWER\s+0x10EF00FF/, 'button name and value');
  assert.match(lirc, /end remote/, 'output has end remote');
});

// --- Export: Samsung code to LIRC ---------------------------------------

test('export Samsung code to LIRC', () => {
  const code = converter.importCode('SAMSUNG', '0xE0E040BF');
  code.alias = 'KEY_POWER';

  const lirc = converter.exportCode(code, 'LIRC', { name: 'SamsungTV' });
  assert.match(lirc, /bits\s+32/, '32-bit Samsung');
  assert.match(lirc, /header\s+4500\s+4500/, 'Samsung header timings');
  assert.match(lirc, /KEY_POWER\s+0xE0E040BF/, 'button value (full 32-bit)');
});

// --- Roundtrip: Samsung LIRC import -> export -> re-import ---------------

test('Samsung LIRC roundtrip', () => {
  const codes = loadLirc('lirc-samsung-tv.lircd.conf');
  const lircOut = converter.exportCodes('LIRC', codes, { name: 'SamsungRT' });

  assert.match(lircOut, /begin remote/, 'roundtrip produces valid LIRC');
  assert.match(lircOut, /SamsungRT/, 'roundtrip preserves name');

  // Re-import should recover the same codes
  const codes2 = converter.importFormat('LIRC', lircOut);
  assert.equal(codes2.length, codes.length, 'roundtrip preserves button count');

  // Check POWER survived
  const p1 = codes.find((c) => c.alias === 'KEY_POWER')!;
  const p2 = codes2.find((c) => c.alias === 'KEY_POWER')!;
  assert.ok(p1 && p2, 'POWER button present in both directions');
  assert.equal(p2.data, p1.data, 'POWER data survives roundtrip');
});

// --- Error handling ------------------------------------------------------

test('error on empty input', () => {
  assert.throws(
    () => converter.importFormat('LIRC', ''),
    /empty/i,
    'rejects empty input',
  );
});

test('error on no begin remote', () => {
  assert.throws(
    () => converter.importFormat('LIRC', 'just some text\nno remote here\n'),
    /begin remote/i,
    'rejects input without begin remote',
  );
});
