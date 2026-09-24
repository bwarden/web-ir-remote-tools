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
    ['{"commands": [{"name": "", "pronto": "0000 006D 0022 0000"}]}', /commands\[0\]\.name: required/],
    ['{"commands": [{"name": "X", "pronto": "nonsense"}]}', /commands\[0\]\.pronto/],
  ] as [string, RegExp][]) {
    assert.throws(() => converter.importFormat('GCIR', text), reason, `rejects: ${text.slice(0, 40)}`);
  }
});

test('GC skips commands without a Pronto payload', () => {
  const codes = converter.importFormat('GCIR', JSON.stringify({
    commands: [
      { name: 'NoSignal' },
      { name: 'Real', pronto: '0000 006D 0002 0000 0071 0072 0013 0013' },
    ],
  }));
  assert.equal(codes.length, 1, 'payload-less command skipped');
  assert.equal(codes[0].alias, 'Real');
});

test('a wig-shaped document is not treated as GC', () => {
  const wig = JSON.stringify({ format: 'hair-wig/3', name: 'R', signals: [] });
  assert.throws(() => converter.importFormat('GCIR', wig), /commands: required/);
});

// Real Global Cache export for an "Eufy 40 Bit" gadget (no registered
// protocol names it). The Pronto hex must survive GC -> WIG -> GC verbatim.
// Three commands extracted from a real GC export (workspace samples/); the
// files themselves are local-only and never shipped with the build.
const eufyGcJson = JSON.stringify({
  commands: [
    {
      keycode: 'G:Eufy 40 Bit:()(0x68A0000008)():3',
      name: 'Auto',
      protocol: 'Eufy 40 Bit',
      pronto: '0000 006D 002A 0000 0071 0072 0013 0013 0013 0039 0013 0039 0013 0013 0013 0039 0013 0013 0013 0013 0013 0013 0013 0039 0013 0013 0013 0039 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0039 0013 0013 0013 0013 0013 0013 0013 0304',
    },
    {
      keycode: 'G:Eufy 40 Bit:()(0x68450632E5)():3',
      name: 'CurrentTime',
      protocol: 'Eufy 40 Bit',
      pronto: '0000 006D 002A 0000 0071 0072 0013 0013 0013 0039 0013 0039 0013 0013 0013 0039 0013 0013 0013 0013 0013 0013 0013 0013 0013 0039 0013 0013 0013 0013 0013 0013 0013 0039 0013 0013 0013 0039 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0039 0013 0039 0013 0013 0013 0013 0013 0013 0013 0039 0013 0039 0013 0013 0013 0013 0013 0039 0013 0013 0013 0039 0013 0039 0013 0039 0013 0013 0013 0013 0013 0039 0013 0013 0013 0039 0013 0304',
    },
    {
      keycode: 'G:Eufy 40 Bit:()(0x68B300001B)():3',
      name: 'DirectionDown',
      protocol: 'Eufy 40 Bit',
      pronto: '0000 006D 002A 0000 0071 0072 0013 0013 0013 0039 0013 0039 0013 0013 0013 0039 0013 0013 0013 0013 0013 0013 0013 0039 0013 0013 0013 0039 0013 0039 0013 0013 0013 0013 0013 0039 0013 0039 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0013 0039 0013 0039 0013 0013 0013 0039 0013 0039 0013 0304',
    },
  ],
}, null, 2);

test('unknown-protocol GC payload converts via WIG losslessly', () => {
  const orig = (JSON.parse(eufyGcJson).commands as Array<{ name: string; pronto: string }>)
    .find((c) => c.name === 'Auto')!.pronto;

  const codes = converter.importFormat('GCIR', eufyGcJson);
  assert.equal(codes.length, 3, 'every command imported (all three unknown)');
  const auto = codes.find((c) => c.alias === 'Auto');
  assert.equal(auto?.protocol, 'UNKNOWN', 'unknown protocol imports as UNKNOWN');
  assert.equal(auto?.bypassProtocol, true, 'raw code sets bypassProtocol');
  assert.equal(auto?.pronto, orig, 'original Pronto hex stashed');
  assert.equal(converter.exportCode(auto as never, 'Pronto'), orig, 'Pronto export re-emits stashed hex');

  const wig = converter.exportCodes('WIG', codes);
  const doc = JSON.parse(wig) as { signals: Array<{ pronto: string; bypass_protocol?: boolean }> };
  assert.equal(doc.signals.length, codes.length, 'wig carries every signal');
  assert.equal(doc.signals[0].pronto, orig, 'wig keeps pronto hex verbatim');

  const reimport = converter.importFormat('WIG', wig);
  assert.equal(reimport.find((c) => c.alias === 'Auto')?.pronto, orig, 'wig -> code keeps pronto hex');
});

test('a GC commands list is never emitted in a WIG export', () => {
  // OpenWig preserves every unknown GC top-level key and hands it to the wig
  // export as opts.extra. The commands list is the GC payload, not wig
  // metadata, so it must not surface in the downloaded wig.
  const codes = converter.importFormat('WIG', eufyGcJson);
  const doc = JSON.parse(eufyGcJson) as Record<string, unknown>;
  const extra: Record<string, unknown> = {};
  for (const key of Object.keys(doc)) {
    if (!['format', 'name', 'brand', 'model', 'kind', 'signals', 'climate'].includes(key)) {
      extra[key] = doc[key];
    }
  }
  assert.ok('commands' in extra, 'commands is an unknown top-level key to the editor');
  const wig = JSON.parse(converter.exportCodes('WIG', codes, { name: 'R', extra })) as Record<string, unknown>;
  assert.ok(!('commands' in wig), 'wig export drops the GC commands payload');
  assert.equal(wig.format, 'hair-wig/3', 'still a valid wig');
});

test('GC repeats survive into a WIG send_count', () => {
  // A real GC export records the repeat count as the trailing ":N" of the
  // keycode; some exports also carry an explicit per-command "repeats" field,
  // which wins when present. Both must land on the wig's send_count and ride
  // a wig -> wig round trip.
  const fieldRepeats = JSON.stringify({
    commands: [
      {
        keycode: 'G:Sony12:()(0xC0)():4',
        name: 'FieldWins',
        repeats: 2,
        pronto: '0000 006D 0022 0000 0156 00AB 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 0663',
        protocol: 'Sony12',
      },
      {
        keycode: 'G:Sony12:()(0xC1)():3',
        name: 'FromKeycode',
        pronto: '0000 006D 0022 0000 0156 00AB 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 0663',
        protocol: 'Sony12',
      },
      {
        keycode: 'G:Sony12:()(0xC2)()',
        name: 'NoRepeat',
        pronto: '0000 006D 0022 0000 0156 00AB 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 0663',
        protocol: 'Sony12',
      },
    ],
  });

  const codes = converter.importFormat('GCIR', fieldRepeats);
  const byAlias = new Map(codes.map((c) => [c.alias, c.sendCount]));
  assert.equal(byAlias.get('FieldWins'), 2, 'the repeats field wins over the keycode suffix');
  assert.equal(byAlias.get('FromKeycode'), 3, 'a bare keycode ":N" suffix supplies the repeat');
  assert.equal(byAlias.get('NoRepeat')!, 0, 'no repeat recorded stays the single-press default');

  const wig = JSON.parse(converter.exportCodes('WIG', codes)) as {
    signals: Array<{ alias: string; send_count?: number }>;
  };
  const signalByAlias = new Map(wig.signals.map((s) => [s.alias, s.send_count]));
  assert.equal(signalByAlias.get('FieldWins'), 2, 'wig carries a non-default send_count');
  assert.equal(signalByAlias.get('FromKeycode'), 3, 'keycode-sourced repeat carries too');
  assert.ok(!('send_count' in wig.signals.find((s) => s.alias === 'NoRepeat')!), 'default single press is not written');

  const reimport = converter.importFormat('WIG', JSON.stringify(wig));
  assert.equal(reimport.find((c) => c.alias === 'FieldWins')?.sendCount, 2, 'wig -> code keeps send_count');
  assert.equal(reimport.find((c) => c.alias === 'FromKeycode')?.sendCount, 3, 'keycode repeat round-trips');
});
