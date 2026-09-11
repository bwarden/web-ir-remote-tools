import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIrdbIndex,
  parseDevicePath,
  exactKey,
  looseKey,
  type IndexSource,
} from '../src/lib/indexer.js';
import { Converter } from '../src/lib/converter.js';

const NEC_CSV = [
  'functionname,protocol,device,subdevice,function',
  'KEY_POWER,NEC,4,-1,8',
  'KEY_MUTE,NEC,4,-1,9',
  'KEY_VOLUP,NEC,4,-1,12',
].join('\n');

const JVC_CSV = [
  'functionname,protocol,device,function',
  'KEY_POWER,JVC,3,12',
].join('\n');

function sources(...pairs: [string, string][]): IndexSource[] {
  return pairs.map(([path, text]) => ({ path, text }));
}

test('indexes devices and inverts the exact and loose code tables', () => {
  const idx = buildIrdbIndex(
    sources(
      ['Sony/TV/KDL-40A100,00.csv', NEC_CSV],
      ['Sony/TV/KDL-40A100,01.csv', JVC_CSV],
    ),
    { version: 'abc123def456', builtAt: 1700000000000 },
  );

  assert.equal(idx.version, 'abc123def456');
  assert.equal(idx.generator, 1, 'defaults to generator 1 when not supplied');
  assert.equal(idx.builtAt, 1700000000000);
  assert.equal(idx.misses, 0);
  assert.equal(idx.devices.length, 2, 'one device entry per indexed CSV');
  assert.deepEqual(idx.devices[0].path, 'Sony/TV/KDL-40A100,00.csv');
  assert.equal(idx.devices[0].brand, 'Sony');
  assert.equal(idx.devices[0].model, 'TV');
  assert.equal(idx.devices[0].address, 'KDL-40A100');
  assert.equal(idx.devices[0].subaddress, '00');
  assert.equal(idx.devices[0].kind, 'tv');
  assert.equal(idx.devices[0].signals, 3);
  assert.ok(idx.devices[0].brand <= idx.devices[1].brand, 'devices sorted by brand');

  // Every code the CSV importer produced must be reachable by both keys.
  const converter = new Converter();
  const codes = converter.importFormat('CSV', NEC_CSV);
  assert.ok(codes.length >= 3);
  for (const c of codes) {
    const ek = exactKey(c);
    const lk = looseKey(c);
    assert.ok(idx.exact[ek], `exact lookup has ${ek}`);
    assert.ok(idx.loose[lk], `loose lookup has ${lk}`);
    assert.ok(
      idx.exact[ek].some((e) => e.path === 'Sony/TV/KDL-40A100,00.csv' && e.alias === c.alias),
      'entry carries path and button alias',
    );
  }

  const jvcCodes = converter.importFormat('CSV', JVC_CSV);
  assert.equal(idx.loose[looseKey(jvcCodes[0])][0].path, 'Sony/TV/KDL-40A100,01.csv');
});

test('skips files that fail to parse and counts them as misses', () => {
  const idx = buildIrdbIndex(
    sources(
      ['Sony/TV/KDL-40A100,00.csv', NEC_CSV],
      ['Broken/Broken/Device,00.csv', 'not,really,csv\n'],
      ['Empty/Empty/Device,00.csv', ''],
    ),
    { version: 'v1' },
  );
  assert.equal(idx.misses, 2, 'garbage and empty files counted as misses');
  assert.equal(idx.devices.length, 1);
});

test('exact and loose keys include protocol, address and command', () => {
  const converter = new Converter();
  const code = converter.importCode('NEC', '0x10EF00FF');
  assert.match(exactKey(code), /^NEC\|/);
  assert.equal(exactKey(code).split('|').length, 4, 'exact key has a subaddress field');
  assert.equal(looseKey(code).split('|').length, 3, 'loose key drops the subaddress');
});

test('repeat-variant rows are keyed under their base protocol too', () => {
  const converter = new Converter();

  const nec2 = converter.importCode('NEC2', { address: 26, subaddress: 232, command: 5 });
  const necx2 = converter.importCode('NECX2', { address: 1, subaddress: 2, command: 3 });
  const nec48 = converter.importCode('48-NEC2', { address: 77, subaddress: 178, command: 222 });

  const idx = buildIrdbIndex(
    sources(
      ['Panasonic/AC/Hokkaido,00.csv', 'functionname,protocol,device,subdevice,function\nKEY_POWER,48-NEC2,77,178,222\n'],
      ['Onkyo/AVR/Receiver,00.csv', 'functionname,protocol,device,subdevice,function\nKEY_POWER,NEC2,26,232,5\n'],
      ['Other/AVR/Receiver,00.csv', 'functionname,protocol,device,subdevice,function\nKEY_POWER,NECX2,1,2,3\n'],
    ),
    { version: 'v1' },
  );

  // A raw timing capture of any of these frames decodes to the base protocol
  // (NEC, NECX1, 48-NEC1), so the base key must resolve the variant rows.
  assert.ok(idx.exact[exactKey(nec2, 'NEC')]?.some((e) => e.path === 'Onkyo/AVR/Receiver,00.csv'),
    'NEC2 row reachable via the NEC exact key');
  assert.ok(idx.loose[looseKey(nec2, 'NEC')]?.some((e) => e.path === 'Onkyo/AVR/Receiver,00.csv'),
    'NEC2 row reachable via the NEC loose key');
  assert.ok(idx.exact[exactKey(nec48, '48-NEC1')]?.some((e) => e.path === 'Panasonic/AC/Hokkaido,00.csv'),
    '48-NEC2 row reachable via the 48-NEC1 key');
  assert.ok(idx.exact[exactKey(necx2, 'NECX1')]?.some((e) => e.path === 'Other/AVR/Receiver,00.csv'),
    'NECX2 row reachable via the NECX1 key');

  // The variant identity is still present for by-name imports.
  assert.ok(idx.exact[exactKey(nec48)]?.some((e) => e.path === 'Panasonic/AC/Hokkaido,00.csv'),
    '48-NEC2 row keeps its own key');
  assert.ok(idx.exact[exactKey(nec2)]?.some((e) => e.path === 'Onkyo/AVR/Receiver,00.csv'),
    'NEC2 row keeps its own key');

  // Aliasing is one-way: a base row must not be keyed under the variant name,
  // since nothing decodes to a "2" variant from raw timing.
  const nec = converter.importCode('NEC', { address: 99, subaddress: 99, command: 99 });
  assert.ok(!idx.exact[exactKey(nec, 'NEC2')], 'base NEC row has no NEC2 key');
  assert.ok(!idx.exact[exactKey(nec, '48-NEC2')], 'base NEC row has no 48-NEC2 key');
});

test('overlap counts repeat-variant devices under the base code', () => {
  // 20 genuine NEC devices plus 20 NEC2 devices all share address 0 command 8.
  // A captured NEC frame cannot tell the two apart, so the shared code must be
  // flagged as overlapping across all 40.
  const srcs = Array.from({ length: 40 }, (_, i) => {
    const protocol = i < 20 ? 'NEC' : 'NEC2';
    return [`B${i}/TV/Model${i},00.csv`, `functionname,protocol,device,subdevice,function\nKEY_POWER,${protocol},0,-1,8\n`] as [string, string];
  });
  const idx = buildIrdbIndex(sources(...srcs), { version: 'v1' });
  assert.equal(idx.overlap['NEC|0|8'], 40, 'NEC and NEC2 devices collide on the same physical code');
});

test('parseDevicePath tolerates a path without the device,subdevice shape', () => {
  const dev = parseDevicePath('Sony/TV/KDL-40A100,01.csv');
  assert.equal(dev.address, 'KDL-40A100');
  assert.equal(dev.subaddress, '01');
  const fallback = parseDevicePath('odd.csv');
  assert.equal(fallback.brand, 'odd.csv');
});

function necDeviceCsv(address: number, subaddress = -1): string {
  return [
    'functionname,protocol,device,subdevice,function',
    `KEY_POWER,NEC,${address},${subaddress},8`,
    `KEY_MUTE,NEC,${address},${subaddress},9`,
  ].join('\n');
}

test('overlap flags only codes shared across many devices', () => {
  const many = Array.from({ length: 40 }, (_, i) =>
    [`Brand${i}/TV/Model${i},00.csv`, necDeviceCsv(0)] as [string, string],
  );
  const idx = buildIrdbIndex(sources(...many), { version: 'v1' });
  assert.equal(idx.overlap['NEC|0|8'], 40, '40 distinct devices share the exact code NEC addr 0 cmd 8');
  assert.ok(!('NEC|0' in idx.overlap), 'the address alone is not a key');
  assert.ok(!('NEC|4|8' in idx.overlap), 'a code used by a single device is not flagged');
});

test('overlap counts distinct devices, not signals or subaddress variants', () => {
  const srcs = Array.from({ length: 39 }, (_, i) =>
    [`B${i}/TV/Model${i},0${i}.csv`, necDeviceCsv(0)] as [string, string],
  );
  srcs.push(['B39/TV/Model39,00.csv', necDeviceCsv(0, 0)]); // same code, subaddress 0
  const idx = buildIrdbIndex(sources(...srcs), { version: 'v1' });
  assert.equal(idx.overlap['NEC|0|8'], 40, 'each device counts once even with multiple signals and a differing subaddress');
  assert.equal(idx.overlap['NEC|0|9'], 40, 'the second shared code is counted too');
  assert.equal(idx.overlap['NEC|1|8'], undefined);
});

function necCodeCsv(address: number, subaddress: number, cmdPower: number, cmdMute: number): string {
  return [
    'functionname,protocol,device,subdevice,function',
    `KEY_POWER,NEC,${address},${subaddress},${cmdPower}`,
    `KEY_MUTE,NEC,${address},${subaddress},${cmdMute}`,
  ].join('\n');
}

test('a common address with fragmented command sets does not trigger overlap', () => {
  // 40 devices all on address 0, but each with its own pair of commands, plus
  // two more devices sharing a command with each other. The address is used by
  // 42 devices, yet no single code is shared by many, so nothing is flagged.
  const srcs = Array.from({ length: 40 }, (_, i) =>
    [`B${i}/TV/Model${i},0${i}.csv`, necCodeCsv(0, -1, i, 100 + i)] as [string, string],
  );
  srcs.push(['B40/TV/Model40,00.csv', necCodeCsv(0, -1, 8, 9)]);
  srcs.push(['B41/TV/Model41,00.csv', necCodeCsv(0, -1, 8, 9)]);
  const idx = buildIrdbIndex(sources(...srcs), { version: 'v1' });
  assert.equal(idx.devices.length, 42, 'all 42 devices indexed');
  assert.ok(Object.keys(idx.overlap).length === 0,
    'no code is shared by enough devices to be flagged');
});

test('skip report explains why files were left out', () => {
  const idx = buildIrdbIndex(
    sources(
      ['Sony/TV/KDL-40A100,00.csv', NEC_CSV],
      ['Philips/TV/RC5-Telly,00.csv', 'functionname,protocol,device,subdevice,function\nKEY_POWER,RC5,0,12,1\n'],
      // No known columns, so the first line becomes data with protocol "REALLY",
      // which is unregistered: the file parses but yields no codes.
      ['Broken/Broken/Device,00.csv', 'not,really,csv\n'],
      ['Empty/Empty/Device,00.csv', ''],
    ),
    { version: 'v1' },
  );
  assert.equal(idx.misses, 3);
  assert.equal(idx.skipped.parseErrors, 1, 'only the empty file fails to parse');
  assert.equal(idx.skipped.noSupportedRows, 2);
  assert.equal(idx.skipped.singleProtocol['RC5'], 1, 'the RC5-only file is attributed to RC5');
  assert.equal(idx.skipped.singleProtocol['REALLY'], 1, 'a file with a single unregistered protocol token is attributed to it');
  assert.equal(idx.skipped.mixedProtocols, 0);
});

test('skip report groups files that mix unsupported protocols', () => {
  const mixed = [
    'functionname,protocol,device,subdevice,function',
    'KEY_POWER,RC5,0,12,1',
    'KEY_VOLUP,SONY12,0,12,16',
  ].join('\n');
  const idx = buildIrdbIndex(
    sources(['Philips/TV/Combo,00.csv', mixed]),
    { version: 'v1' },
  );
  assert.equal(idx.skipped.noSupportedRows, 1);
  assert.equal(idx.skipped.mixedProtocols, 1);
  assert.equal(Object.keys(idx.skipped.singleProtocol).length, 0);
});
