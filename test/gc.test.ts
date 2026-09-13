// Global Caché IR database JSON import: field names differ from HAIR wig
// ("commands" list with name/pronto/keycode/protocol) but the signal payload
// is the same raw Pronto hex, so both the explicit GCIR/GlobalCache formats
// and the wig entry point must import it to the same IRCode list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Converter } from '../src/lib/converter.js';
import { bitReverseBytes } from '../src/lib/code.js';

const converter = new Converter();

// Two RM-SG20 (NEC, address 131 = 0x83) buttons in the Global Caché database
// shape. The keycode value is the accumulated wire word; the Pronto hex is
// the same timing the wig importer would carry.
const gcJson = JSON.stringify({
  commands: [
    {
      keycode: 'G:Memorex 32 Bit:()(0xC10000FF)():3',
      name: 'PowerToggle',
      pronto: `0000 006D 0022 0000 0156 00AB 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 0663`,
      protocol: 'Memorex 32 Bit',
    },
    {
      keycode: 'G:Memorex 32 Bit:()(0xC10040BF)():3',
      name: 'VolumeUp',
      pronto: `0000 006D 0022 0000 0156 00AB 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 0663`,
      protocol: 'Memorex 32 Bit',
    },
  ],
}, null, 2);

// The NEC display word for address 131/subaddress 0 and a command byte.
const displayFor = (cmd: number) => (0x83 << 24) | ((cmd & 0xff) << 8) | (~cmd & 0xff);

test('GCIR imports the commands as Pronto-decoded IRCode', () => {
  const codes = converter.importFormat('GCIR', gcJson);
  assert.equal(codes.length, 2, 'two commands imported');

  const [power, vol] = codes;
  assert.equal(power.alias, 'PowerToggle', 'alias from name');
  assert.equal(power.protocol, 'NEC');
  assert.equal(power.bits, 32);
  assert.equal(power.address, 131);
  assert.equal(power.subaddress, 0);
  assert.equal(power.command, 0);
  assert.equal(power.data, displayFor(0) >>> 0, 'display-form data');
  assert.equal(bitReverseBytes(power.data as number, power.bits), 0xc10000ff, 'datalsb is the keycode word');

  assert.equal(vol.alias, 'VolumeUp');
  assert.equal(vol.command, 2);
  assert.equal(vol.data, displayFor(2) >>> 0);
  assert.equal(bitReverseBytes(vol.data as number, vol.bits), 0xc10040bf);
});

test('GlobalCache is an alias for GCIR', () => {
  const a = converter.importFormat('GlobalCache', gcJson);
  const b = converter.importFormat('GCIR', gcJson);
  assert.deepEqual(a, b);
});

test('the wig entry point imports a GC export interchangeably', () => {
  const viaWig = converter.importFormat('WIG', gcJson);
  const viaGc = converter.importFormat('GCIR', gcJson);
  assert.deepEqual(viaWig, viaGc, 'WIG and GCIR produce identical codes');
  assert.equal(viaWig[0].protocol, 'NEC');
});

test('GC validation is all-or-nothing with field-level reasons', () => {
  for (const [text, reason] of [
    ['{ not json', /not valid JSON/],
    ['[1,2,3]', /top level must be a JSON object/],
    ['{}', /commands: required/],
    ['{"commands": 3}', /commands: must be a list/],
    ['{"commands": []}', /commands: must not be empty/],
    ['{"commands": [{"name": "X"}]}', /commands\[0\]\.pronto: required/],
    ['{"commands": [{"name": "", "pronto": "0000 006D 0022 0000"}]}', /commands\[0\]\.name: required/],
    ['{"commands": [{"name": "X", "pronto": "nonsense"}]}', /commands\[0\]\.pronto/],
  ] as [string, RegExp][]) {
    assert.throws(() => converter.importFormat('GCIR', text), reason, `rejects: ${text.slice(0, 40)}`);
  }
});

test('a wig-shaped document is not treated as GC', () => {
  const wig = JSON.stringify({ format: 'hair-wig/3', name: 'R', signals: [] });
  assert.throws(() => converter.importFormat('GCIR', wig), /commands: required/);
});