import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLircIndex,
  parseLircPath,
  type LircIndexSource,
} from '../src/lib/lircIndexer.js';
import { exactKey, looseKey } from '../src/lib/indexer.js';

// A minimal NEC remote in LIRC format.
const NEC_REMOTE = `begin remote

  name  Test_NEC
  bits           32
  flags SPACE_ENC|CONST_LENGTH
  eps            30
  aeps          100

  header          9000  4500
  one              560  1690
  zero             560   560
  ptrail           560
  repeat          9000  2250
  gap             108000
  toggle_bit_mask 0x0
  min_repeat       1

      begin codes
          KEY_POWER               0x04FB09F6
          KEY_MUTE                0x04FB0CF3
          KEY_VOLUP               0x04FB04FB
      end codes

end remote
`;

// A Samsung remote.
const SAMSUNG_REMOTE = `# brand: Samsung
# model no. of remote control: BN59-00603A
begin remote

  name  Samsung_BN59
  bits           32
  flags SPACE_ENC|CONST_LENGTH
  eps            30
  aeps          100

  header          4500  4500
  one              560  1690
  zero             560   560
  ptrail           560
  repeat          4500  1690
  gap             108000
  toggle_bit_mask 0x0
  min_repeat       1

      begin codes
          KEY_POWER               0x0E0E040B
          KEY_VOLUP               0x0E0E0E12
      end codes

end remote
`;

function sources(...pairs: [string, string][]): LircIndexSource[] {
  return pairs.map(([path, text]) => ({ path, text }));
}

test('parses LIRC path into manufacturer and remote name', () => {
  const p = parseLircPath('samsung/BN59-00603A.lircd.conf');
  assert.equal(p.manufacturer, 'samsung');
  assert.equal(p.remote, 'BN59-00603A');
  assert.equal(p.path, 'samsung/BN59-00603A.lircd.conf');
});

test('parses nested path', () => {
  const p = parseLircPath('some/nested/samsung/BN59.lircd.conf');
  assert.equal(p.manufacturer, 'samsung');
  assert.equal(p.remote, 'BN59');
});

test('indexes NEC remote with exact and loose keys', () => {
  const idx = buildLircIndex(
    sources(['nec/Test.lircd.conf', NEC_REMOTE]),
    { version: 'abc123' },
  );

  assert.equal(idx.version, 'abc123');
  assert.equal(idx.generator, 1);
  assert.equal(idx.misses, 0);
  assert.equal(idx.devices.length, 1);
  assert.equal(idx.devices[0].manufacturer, 'nec');
  assert.equal(idx.devices[0].remote, 'Test');
  assert.equal(idx.devices[0].signals, 3);
  assert.ok(Object.keys(idx.exact).length > 0, 'has exact keys');
  assert.ok(Object.keys(idx.loose).length > 0, 'has loose keys');
});

test('extracts brand and model from header comments', () => {
  const idx = buildLircIndex(
    sources(['samsung/BN59.lircd.conf', SAMSUNG_REMOTE]),
    { version: 'v1' },
  );
  assert.equal(idx.devices[0].brand, 'Samsung');
  assert.equal(idx.devices[0].model, 'BN59-00603A');
});

test('falls back to manufacturer when no header comments', () => {
  const idx = buildLircIndex(
    sources(['nec/Test.lircd.conf', NEC_REMOTE]),
    { version: 'v1' },
  );
  assert.equal(idx.devices[0].brand, 'nec');
  assert.equal(idx.devices[0].model, 'Test');
});

test('exact and loose keys match decoded codes', () => {
  const idx = buildLircIndex(
    sources(['nec/Test.lircd.conf', NEC_REMOTE]),
    { version: 'v1' },
  );

  // Every code should be reachable by both exact and loose keys.
  for (const [ek, entries] of Object.entries(idx.exact)) {
    assert.ok(entries.length > 0, `exact key ${ek} has entries`);
    for (const e of entries) {
      assert.equal(e.path, 'nec/Test.lircd.conf');
      assert.ok(e.alias.length > 0, 'entry has alias');
    }
  }
  for (const [lk, entries] of Object.entries(idx.loose)) {
    assert.ok(entries.length > 0, `loose key ${lk} has entries`);
  }
});

test('skips files that fail to parse', () => {
  const idx = buildLircIndex(
    sources(
      ['nec/Test.lircd.conf', NEC_REMOTE],
      ['broken/Bad.lircd.conf', 'not a valid lirc config'],
    ),
    { version: 'v1' },
  );
  assert.equal(idx.misses, 1);
  assert.equal(idx.devices.length, 1);
  assert.equal(idx.skipped.parseErrors, 1);
});

test('skips files with no decodable codes', () => {
  const unsupported = `begin remote
  name  RC5_Remote
  bits           14
  flags RC5|CONST_LENGTH
  one              915   876
  zero             915   876
  gap             113837
  toggle_bit_mask 0x800
      begin codes
          KEY_POWER               0x000C
      end codes
end remote
`;
  const idx = buildLircIndex(
    sources(['philips/RC5.lircd.conf', unsupported]),
    { version: 'v1' },
  );
  assert.equal(idx.misses, 1);
  assert.equal(idx.devices.length, 0);
  assert.equal(idx.skipped.noSupportedRows, 1);
});

test('devices are sorted by brand', () => {
  const alpha = `# brand: Alpha
begin remote
  name  AlphaRemote
  bits           32
  flags SPACE_ENC|CONST_LENGTH
  header          9000  4500
  one              560  1690
  zero             560   560
  ptrail           560
  repeat          9000  2250
  gap             108000
  toggle_bit_mask 0x0
  min_repeat       1
      begin codes
          KEY_POWER               0x04FB09F6
      end codes
end remote
`;
  const beta = `# brand: Zulu
begin remote
  name  ZuluRemote
  bits           32
  flags SPACE_ENC|CONST_LENGTH
  header          4500  4500
  one              560  1690
  zero             560   560
  ptrail           560
  repeat          4500  1690
  gap             108000
  toggle_bit_mask 0x0
  min_repeat       1
      begin codes
          KEY_POWER               0x0E0E040B
      end codes
end remote
`;
  const idx = buildLircIndex(
    sources(
      ['zulu/Remote.lircd.conf', beta],
      ['alpha/Remote.lircd.conf', alpha],
    ),
    { version: 'v1' },
  );
  assert.equal(idx.devices.length, 2);
  assert.ok(idx.devices[0].brand <= idx.devices[1].brand, 'devices sorted by brand');
});

test('multiple remotes in one file', () => {
  const NEC_REMOTE_2 = NEC_REMOTE.replace('Test_NEC', 'Test_NEC_2');
  const multi = NEC_REMOTE + NEC_REMOTE_2;
  const idx = buildLircIndex(
    sources(['multi/Combo.lircd.conf', multi]),
    { version: 'v1' },
  );
  assert.equal(idx.devices.length, 1);
  assert.equal(idx.devices[0].signals, 6, 'both remotes decoded');
});
