import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Converter } from '../src/lib/converter.js';
import { IRCode, toHex } from '../src/lib/code.js';

const converter = new Converter();
const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');
const samples = join(here, '..', 'samples');

function loadCsv(file: string) {
  return converter.importFormat('CSV', readFileSync(join(fixtures, file), 'utf8'));
}

function loadCodesCsv(protocol: string, file: string, device?: string) {
  const input: any = { protocol, text: readFileSync(join(samples, file), 'utf8') };
  if (device !== undefined) input.device = device;
  return converter.importFormat('CodesCSV', input);
}

test('inline CSV with normalized protocols', () => {
  const csv = [
    'functionname,protocol,device,subdevice,function',
    'KEY_POWER,NEC1,4,0,8',
    'KEY_MUTE,NEC1,4,0,9',
    'KEY_VOLUP,JVC,3,-1,12',
  ].join('\n');

  const codes = converter.importFormat('CSV', csv);
  assert.equal(codes.length, 3, 'parsed three rows');
  assert.equal(codes[0].alias, 'KEY_POWER');
  assert.equal(codes[0].protocol, 'NEC', 'NEC1 normalized to NEC');
  assert.equal(codes[0].address, 4);
  assert.equal(codes[1].command, 9);
  assert.equal(codes[2].protocol, 'JVC');
  assert.equal(codes[2].subaddress, -1);

  const rawCsv = ['name,protocol,data', 'KEY_ON,NEC,0x10EF00FF'].join('\n');
  const rawCodes = converter.importFormat('CSV', rawCsv);
  assert.equal(rawCodes.length, 1, 'raw data row parsed');
  assert.equal(rawCodes[0].data, 0x10ef00ff, 'raw hex data imported');
});

test('CSV maps NEC and JVC label variants to their base protocol', () => {
  const csv = [
    'functionname,protocol,device,subdevice,function',
    'POWER,NEC1-f16,210,30,24',
    'MUTE,NEC2-f16,210,31,24',
    'VOLUP,NEC1-y1,126,-1,0',
    'VOLMEM,NEC1-y2,122,-1,0',
    'TONE,NEC1-y3,127,1,0',
    'XLEFT,NEC1-rnc,238,135,26',
    'DISPLAY,JVC{2},83,-1,36',
    'WIDE,JVC-48,34,33,3',
  ].join('\n');

  const codes = converter.importFormat('CSV', csv);
  const proto = codes.map((c) => c.protocol);
  assert.deepEqual(proto, ['NEC', 'NEC2', 'NEC', 'NEC', 'NEC', 'NEC', 'JVC', 'JVC-48']);
  assert.equal(codes[0].address, 210, 'F16 address byte kept');
  assert.equal(codes[0].command, 24, 'F16 command byte kept');
  assert.equal(codes[6].subaddress, -1, 'JVC{2} normalized subaddress');
  assert.equal(codes[6].command, 36, 'JVC{2} OBC byte kept');
  assert.equal(codes[7].protocol, 'JVC-48', 'JVC-48 decodes through its own handler');
  assert.equal(codes[7].address, 34);
  assert.equal(codes[7].subaddress, 33);
  assert.equal(codes[7].command, 3);
  assert.equal(codes.length, 8, 'every row decodes');
});

test('mixed IRDB CSV skips unregistered protocols', () => {
  const csv = [
    'functionname,protocol,device,subdevice,function',
    'KEY_POWER,NEC1,4,0,8',
    'KEY_SONY,Sony12,1,0,2',
    'KEY_ON,NECX2,25,-1,8',
    'KEY_MUTE2,NEC2,26,232,5',
    'KEY_PLAY,JVC,3,-1,12',
  ].join('\n');

  const mixed = converter.importFormat('CSV', csv);
  assert.equal(mixed.length, 4, 'unregistered protocol rows are skipped');
  assert.equal(mixed[0].protocol, 'NEC');
  assert.equal(mixed[1].protocol, 'NECX2', 'NECx2 row kept');
  assert.equal(mixed[1].data, 0x191908f7, 'NECx2 25,-1,8 packs with S=D');
  assert.equal(mixed[2].protocol, 'NEC2', 'NEC2 row kept');
  assert.equal(mixed[3].protocol, 'JVC', 'JVC row kept');
});

test('real IRDB NEC receiver fixture', () => {
  const nec = loadCsv('irdb-nec-receiver.csv');
  assert.equal(nec.length, 7, 'NEC fixture yields 7 buttons');

  const byAlias = new Map(nec.map((c) => [c.alias, c]));
  const power = byAlias.get('VCR POWER')!;
  assert.ok(power, 'POWER button imported');
  assert.equal(power.protocol, 'NEC', 'NEC1 normalized to NEC');
  assert.equal(power.address, 25);
  assert.equal(power.subaddress, -1, 'single-byte address inferred');
  assert.equal(power.command, 8);
  assert.equal(power.data, 0x19e608f7, 'POWER packs into expected data word');
  assert.equal(byAlias.get('VCR STOP []')!.data, 0x19e604fb, 'STOP packs into expected data word');

  const rt = converter.importFormat('Pronto', converter.exportCode(power, 'Pronto'))[0];
  assert.equal(rt.address, 25, 'NEC POWER address survives Pronto roundtrip');
  assert.equal(rt.command, 8);
  assert.equal(rt.data, 0x19e608f7);
});

test('real IRDB JVC VCR fixture', () => {
  const jvc = loadCsv('irdb-jvc-vcr.csv');
  assert.ok(jvc.length >= 5, 'JVC fixture yields its buttons');
  const byAlias = new Map(jvc.map((c) => [c.alias, c]));
  const stop = byAlias.get('TAPE STOP []')!;
  assert.ok(stop, 'STOP button imported');
  assert.equal(stop.protocol, 'JVC');
  assert.equal(stop.data, 0x8303, 'STOP packs address 0x83 with function 3');
});

test('headerless IRDB CSV falls back to standard column order', () => {
  const csv = [
    'YELLOW,NEC,1,254,0',
    'BLUE,NEC,1,254,3',
    'STOP,NEC,1,254,4',
  ].join('\n');
  const codes = converter.importFormat('CSV', csv);
  assert.equal(codes.length, 3, 'first line is read as a button, not a header');
  assert.equal(codes[0].alias, 'YELLOW');
  assert.equal(codes[0].protocol, 'NEC');
  assert.equal(codes[0].address, 1);
  assert.equal(codes[0].subaddress, 254);
  assert.equal(codes[0].command, 0);
  assert.equal(codes[2].command, 4);
});

test('tab-joined CSV header splits into separate columns', () => {
  const csv = [
    'functionname\tprotocol,device,subdevice,function',
    'Left Arrow,NEC1,134,107,4',
    'Enter,NEC1,134,107,5',
  ].join('\n');
  const codes = converter.importFormat('CSV', csv);
  assert.equal(codes.length, 2, 'rows decode despite the tab in the header');
  assert.equal(codes[0].alias, 'Left Arrow');
  assert.equal(codes[0].protocol, 'NEC', 'NEC1 normalized to NEC');
  assert.equal(codes[0].address, 134);
  assert.equal(codes[0].subaddress, 107);
  assert.equal(codes[0].command, 4);
});

test('CSV export writes the IRDB column layout and roundtrips', () => {
  const src = [
    'functionname,protocol,device,subdevice,function',
    'VCR POWER,NEC1,25,-1,8',
    'TAPE STOP [],JVC,131,-1,3',
    'KEY_ON,NEC,4,0,8',
    '"TV, On",NEC,4,1,9',
  ].join('\n');
  const codes = converter.importFormat('CSV', src);
  assert.equal(codes.length, 4);

  codes[0].bypassProtocol = true;
  const csv = converter.exportCodes('CSV', codes);
  const expected = [
    'functionname,protocol,device,subdevice,function',
    'TAPE STOP [],JVC,131,-1,3',
    'KEY_ON,NEC,4,0,8',
    '"TV, On",NEC,4,1,9',
  ].join('\n') + '\n';
  assert.equal(csv, expected, 'bypass rows are skipped and commas are quoted');

  const rt = converter.importFormat('CSV', csv);
  assert.equal(rt.length, 3, 'export reimports every row');
  const want = [
    ['TAPE STOP []', 'JVC', 131, -1, 3],
    ['KEY_ON', 'NEC', 4, 0, 8],
    ['TV, On', 'NEC', 4, 1, 9],
  ];
  rt.forEach((code, i) => {
    assert.equal(code.alias, want[i][0]);
    assert.equal(code.protocol, want[i][1]);
    assert.equal(code.address, want[i][2]);
    assert.equal(code.subaddress, want[i][3]);
    assert.equal(code.command, want[i][4]);
    assert.ok(code.data !== undefined, 'data word reconstructs');
  });
});

test('wig export and roundtrip', () => {
  const codes = [
    new IRCode({ protocol: 'NEC', bits: 32, data: 0x10ef00ff, address: 0x10, subaddress: -1, command: 0, alias: 'POWER' }),
    new IRCode({ protocol: 'JVC', bits: 16, data: 0x030c, address: 3, command: 12, alias: 'MUTE', dittoCount: 1, bypassProtocol: true }),
    new IRCode({ protocol: 'SAMSUNG', bits: 32, data: 0x070702fd, address: 0xe0, command: 0x40, alias: 'POWER-SAM' }),
  ];

  const wigText = converter.exportCodes('WIG', codes, { name: 'Test Remote', brand: 'Acme', model: 'X-1' });
  const data = JSON.parse(wigText);
  assert.equal(data.format, 'hair-wig/3');
  assert.equal(data.name, 'Test Remote');
  assert.equal(data.brand, 'Acme');
  assert.equal(data.model, 'X-1');
  assert.equal(data.origin, 'converted:ir-remote-tools');
  assert.match(
    data.wig_id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    'wig_id is a UUID v4',
  );
  assert.equal(data.signals.length, 3, 'three signals exported');

  const signals: any[] = data.signals;
  const byAlias = new Map<string, any>(signals.map((s: any) => [s.alias, s]));
  assert.equal(byAlias.get('POWER').bypass_protocol, false);
  assert.equal(byAlias.get('POWER').ditto_count, 0);
  assert.equal(byAlias.get('MUTE').ditto_count, 0, 'JVC is not NEC-family, so ditto_count is always 0');
  assert.equal(byAlias.get('MUTE').bypass_protocol, true);

  const back = converter.importFormat('WIG', wigText);
  assert.equal(back.length, 3);
  const byAliasBack = new Map(back.map((c) => [c.alias, c]));
  assert.equal(byAliasBack.get('POWER')!.data, 0x10ef00ff, 'NEC POWER data survives wig roundtrip');
  assert.equal(byAliasBack.get('MUTE')!.dittoCount, 0, 'bypass forces ditto_count 0');
  assert.equal(byAliasBack.get('MUTE')!.bypassProtocol, true, 'bypass_protocol survives wig roundtrip');
  assert.equal(byAliasBack.get('MUTE')!.data, 0x030c);
  assert.equal(byAliasBack.get('POWER-SAM')!.data, 0x070702fd);
});

test('wig export names unknown commands and drops unnamed duplicates', () => {
  const codes = [
    new IRCode({ protocol: 'JVC', bits: 16, data: 0x4310, address: 67, command: 16, alias: '' }),
    new IRCode({ protocol: 'JVC', bits: 16, data: 0x43cc, address: 67, command: 204, alias: '' }),
    new IRCode({ protocol: 'JVC', bits: 16, data: 0x4310, address: 67, command: 16, alias: 'TV' }),
    new IRCode({ protocol: 'JVC', bits: 16, data: 0x43cc, address: 67, command: 204, alias: 'RECORD' }),
    new IRCode({ protocol: 'JVC', bits: 16, data: 0x4310, address: 67, command: 16, alias: 'TV' }),
    new IRCode({ protocol: 'JVC', bits: 16, address: 67, command: 17, alias: '' }),
  ];

  const wigText = converter.exportCodes('WIG', codes, { name: 'Test' });
  const data = JSON.parse(wigText);
  const aliases: string[] = data.signals.map((s: any) => s.alias);
  assert.equal(data.signals.length, 4, 'unnamed duplicates of named commands are dropped');
  assert.deepEqual(
    new Set(aliases),
    new Set(['TV', 'RECORD', 'UNKNOWN 17']),
    'named buttons survive and the genuinely new unnamed command is named UNKNOWN <command>',
  );
  assert.equal(aliases.filter((a) => a === 'TV').length, 2, 'named duplicates are kept verbatim');
  for (const a of aliases) {
    assert.ok(typeof a === 'string' && a !== '', `every alias is non-empty (got ${JSON.stringify(a)})`);
  }

  const back = converter.importFormat('WIG', wigText);
  assert.equal(back.length, 4, 'the wig roundtrips once aliases are non-empty');
});

test('wig export keeps UNKNOWN names unique', () => {
  const codes = [
    new IRCode({ protocol: 'JVC', bits: 16, data: 0x4310, address: 67, command: 16, alias: '' }),
    new IRCode({ protocol: 'JVC', bits: 16, data: 0x4110, address: 65, command: 16, alias: '' }),
  ];
  const aliases = JSON.parse(converter.exportCodes('WIG', codes, { name: 'Test' })).signals.map((s: any) => s.alias);
  assert.deepEqual(
    new Set(aliases),
    new Set(['UNKNOWN 16', 'UNKNOWN 16_2']),
    'two distinct unnamed commands with the same command number stay unique',
  );
});

test('wig import validates all-or-nothing with field-level reasons', () => {
  const code = new IRCode({ protocol: 'NEC', bits: 32, data: 0x10ef00ff, address: 0x10, subaddress: -1, command: 0, alias: 'POWER' });
  const wigText = converter.exportCodes('WIG', [code], { name: 'Test' });
  const data = JSON.parse(wigText);

  assert.throws(
    () => converter.importFormat('WIG', JSON.stringify({ ...data, name: '' })),
    /name: required/,
    'name is required',
  );
  assert.throws(
    () => converter.importFormat('WIG', JSON.stringify({ ...data, format: 'hair-wig/4' })),
    /newer than this tool/,
    'a higher major version is refused with a version message',
  );
  assert.throws(
    () => converter.importFormat('WIG', JSON.stringify({ ...data, signals: [] })),
    /must not be empty/,
    'an empty signals list is refused',
  );
  assert.throws(
    () => converter.importFormat('WIG', JSON.stringify({ ...data, signals: undefined })),
    /signals: required/,
  );
  assert.throws(
    () => converter.importFormat('WIG', JSON.stringify({ ...data, climate: { min_temp: 16, max_temp: 30 } })),
    /climate/,
    'matrix wigs are refused, not half-imported',
  );

  const bad = {
    ...data,
    signals: [{
      ...data.signals[0],
      pronto: '0000 006d 0022 0002',
      ditto_count: 'three',
      bypass_protocol: 'yes',
    }],
  };
  try {
    converter.importFormat('WIG', JSON.stringify(bad));
    assert.fail('a wig with several malformed fields should throw');
  } catch (e) {
    const msg = (e as Error).message;
    assert.match(msg, /signals\[0\]\.pronto/, 'pronto problem is reported by field');
    assert.match(msg, /signals\[0\]\.ditto_count/, 'ditto problem is reported by field');
    assert.match(msg, /signals\[0\]\.bypass_protocol/, 'bypass problem is reported by field');
  }

  assert.equal(
    converter.importFormat('WIG', JSON.stringify({ ...data, format: 'hair-wig/2' })).length,
    1,
    'older majors still read',
  );

  const extra = {
    ...data,
    identifiers: { upc: '812345678901', asin: ['B0EXAMPLE'] },
    supersedes: '00000000-0000-4000-8000-000000000000',
    some_future_key: { anything: true },
  };
  const back = converter.importFormat('WIG', JSON.stringify(extra));
  assert.equal(back[0].data, 0x10ef00ff, 'unknown and optional metadata keys are tolerated');
});

test('wig export preserves unknown and optional top-level keys', () => {
  const code = new IRCode({ protocol: 'NEC', bits: 32, data: 0x10ef00ff, address: 0x10, subaddress: -1, command: 0, alias: 'POWER' });
  const wigText = converter.exportCodes('WIG', [code], {
    name: 'Test',
    wigId: '00000000-0000-4000-8000-000000000000',
    origin: 'captured',
    notes: 'Captured from hardware',
    extra: {
      identifiers: { upc: '812345678901' },
      supersedes: ['aaa'],
      some_future_key: { x: 1 },
    },
  });
  const data = JSON.parse(wigText);
  assert.equal(data.wig_id, '00000000-0000-4000-8000-000000000000', 'existing wig_id is kept');
  assert.equal(data.origin, 'captured', 'existing origin wins over the default stamp');
  assert.equal(data.notes, 'Captured from hardware');
  assert.deepEqual(data.identifiers, { upc: '812345678901' });
  assert.deepEqual(data.supersedes, ['aaa']);
  assert.deepEqual(data.some_future_key, { x: 1 }, 'an unknown key rides through untouched');

  const back = converter.importFormat('WIG', wigText);
  assert.equal(back[0].data, 0x10ef00ff, 'preserved keys do not disturb the signals');
});

test('SAMSUNG data survives wig roundtrip as 0x070702FD', () => {
  const code = new IRCode({ protocol: 'SAMSUNG', bits: 32, data: 0x070702fd, address: 0xe0, command: 0x40, alias: 'POWER' });
  const wigText = converter.exportCodes('WIG', [code]);
  const back = converter.importFormat('WIG', wigText)[0];
  assert.equal(back.data, 0x070702fd);
  assert.equal('0x' + toHex(back.data!, 8), '0x070702FD');
});

test('wig export enforces the format contract on ditto_count and kind', () => {
  const nec = new IRCode({ protocol: 'NEC', bits: 32, data: 0x10ef00ff, address: 0x10, subaddress: -1, command: 0, alias: 'POWER', dittoCount: 3 });
  const bypass = new IRCode({ protocol: 'NEC', bits: 32, data: 0x10ef00ff, address: 0x10, subaddress: -1, command: 0, alias: 'PINNED', dittoCount: 4, bypassProtocol: true });
  const samsung = new IRCode({ protocol: 'SAMSUNG', bits: 32, data: 0x070702fd, address: 0xe0, command: 0x40, alias: 'POWER-SAM', dittoCount: 2 });

  const wigText = converter.exportCodes('WIG', [nec, bypass, samsung], { name: 'Contract', kind: 'Sound Bar', model: 'X' });
  const data = JSON.parse(wigText);
  assert.equal(data.kind, 'soundbar', 'kind is squashed to lowercase letters and digits');
  const byAlias = new Map<any, any>(data.signals.map((s: any) => [s.alias, s]));
  assert.equal(byAlias.get('POWER').ditto_count, 3, 'NEC keeps its ditto count');
  assert.equal(byAlias.get('PINNED').ditto_count, 0, 'a bypassed signal cannot carry ditto_count');
  assert.equal(byAlias.get('POWER-SAM').ditto_count, 0, 'a non-NEC signal always reads 0');

  const back = converter.importFormat('WIG', wigText);
  const byAliasBack = new Map(back.map((c) => [c.alias, c]));
  assert.equal(byAliasBack.get('POWER')!.dittoCount, 3, 'ditto count survives the roundtrip');
  assert.equal(byAliasBack.get('PINNED')!.dittoCount, 0, 'bypass forces ditto_count 0 on read too');
  assert.equal(byAliasBack.get('POWER-SAM')!.dittoCount, 0);
});

test('CodesCSV imports the NEC sample table through its byte-order columns', () => {
  const nec = loadCodesCsv('NEC', 'IR Remote Control Codes - NEC.csv');
  assert.equal(nec.length, 273, 'NEC sample yields every data row');

  const power = nec[0];
  assert.equal(power.protocol, 'NEC');
  assert.equal(power.alias, 'Power');
  assert.equal(power.device, 'Capello DVD', 'device-type name kept on the code');
  assert.equal(power.address, 0, 'Power row address matches its numeric column');
  assert.equal(power.command, 74, 'Power row command matches its numeric column');
  assert.equal(power.data, 0x00ff4ab5, 'Power row data is the LSB column');

  const vizio = new Map(nec.map((c) => [c.alias, c])).get('Enter');
  assert.equal(vizio?.data, 0x04fbff00, 'Vizio Enter data survives import');

  const devices = loadCodesCsv('NEC', 'IR Remote Control Codes - NEC.csv', 'Vizio TV');
  assert.equal(devices.length, 45, 'device filter keeps only the Vizio TV rows');
  assert.ok(devices.every((c) => c.alias), 'every filtered row keeps its button name');
  assert.ok(devices.every((c) => c.device === 'Vizio TV'), 'every filtered row keeps its device');
});

test('CodesCSV imports the JVC sample table using the Command column for names', () => {
  const jvc = loadCodesCsv('JVC', 'IR Remote Control Codes - JVC.csv');
  assert.equal(jvc.length, 125, 'JVC sample yields every data row');

  const sleep = jvc[0];
  assert.equal(sleep.protocol, 'JVC');
  assert.equal(sleep.alias, 'Sleep', 'JVC button name comes from the Command column');
  assert.equal(sleep.device, 'LCD TV', 'device-type name kept on the code');
  assert.equal(sleep.address, 3, 'Sleep row address matches its numeric column');
  assert.equal(sleep.command, 3, 'Sleep row command matches its numeric column');
  assert.equal(sleep.data, 0x0303, 'Sleep row data is the LSB column');

  const byAlias = new Map(jvc.map((c) => [c.alias, c]));
  assert.equal(byAlias.get('Reverse')!.data, 0x0f8e, 'Reverse row data survives import');
  assert.equal(byAlias.get('Forward')!.data, 0x0f8f, 'Forward row data survives import');
});

test('CodesCSV imports the Samsung36 sample table with 36-bit data words', () => {
  const s36 = loadCodesCsv('SAMSUNG36', 'IR Remote Control Codes - Samsung36.csv');
  assert.equal(s36.length, 42, 'Samsung36 sample yields every data row');

  const search = s36[0];
  assert.equal(search.protocol, 'SAMSUNG36');
  assert.equal(search.alias, 'Search');
  assert.equal(search.device, 'Samsung Bluray', 'device-type name kept on the code');
  assert.equal(search.bits, 36, 'Samsung36 rows import as 36-bit');
  assert.equal(search.address, 0x400, 'Search row address matches its hex column');
  assert.equal(search.command, 0xebc43, 'Search row command matches its hex column');
  assert.equal(search.data, 0x400ebc43, 'Search row data is the display (Code) column');

  const power = new Map(s36.map((c) => [c.alias, c])).get('Power')!;
  assert.equal(power.address, 0x400);
  assert.equal(power.command, 0xe00ff);
  assert.equal(power.data, 0x400e00ff, 'Power row matches the IRremoteESP8266 value');

  const eject = s36.find((c) => c.alias === 'Eject')!;
  assert.equal(eject.address, 1024, 'row with a decimal Address column still decodes');
  assert.equal(eject.data, 0x400e807f, 'decimal-params row data survives import');
});

test('CodesCSV refuses input without a protocol', () => {
  assert.throws(
    () => converter.importFormat('CodesCSV', { text: 'Code,LSB\n0xFF52AD,0x00FF4AB5\n' }),
    /needs a protocol/,
  );
});
