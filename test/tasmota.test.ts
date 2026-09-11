import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Converter } from '../src/lib/converter.js';
import { IRCode, dataHex } from '../src/lib/code.js';

// Port of the Perl t/12-tasmota.t battery: decode real Tasmota captures from
// the fixture log, check the decoded data against the log's own DataLSB
// field, and roundtrip each capture through both the compact and comma
// Tasmota styles.

const converter = new Converter();
const here = dirname(fileURLToPath(import.meta.url));
const captures = readFileSync(join(here, 'fixtures', 'tasmota-captures.log'), 'utf8');

test('decode compact form', () => {
  const compact =
    '+9185-4490+650-500+655dE-1630C-505+630-525Ed+625-530H-520H-1655JmJiCfCfHmH-1650CfHmHiEdCfCdHiHiEdHiEfCfHiEfEfEfEfC-40270+9160-2235H';
  const code = converter.importFormat('Tasmota', compact)[0];
  assert.equal(code.protocol, 'NEC', 'compact form decodes to NEC');
  assert.equal(code.data, 0x04fb09f6, 'compact form yields DataLSB value');
  assert.ok(code.timings, 'timings retained on the code');
  assert.equal(code.timings!.length, 71, '71 timing values from the capture');
});

test('compact encode reproduces the original capture losslessly', () => {
  // The compact codec is lossless for real captures: timings in the log are
  // already multiples of 5us, and the letter table is assigned in order of
  // first appearance, so re-encoding a decoded capture yields the exact text.
  const raw =
    '+9185-4490+650-500+655dE-1630C-505+630-525Ed+625-530H-520H-1655JmJiCfCfHmH-1650CfHmHiEdCfCdHiHiEdHiEfCfHiEfEfEfEfC-40270+9160-2235H';
  const orig = converter.importFormat('Tasmota', raw)[0];
  assert.ok(orig.timings);
  assert.equal(orig.timings!.length, 71);
  const reencoded = converter.exportCode(orig, 'Tasmota').slice('IRSend 0,'.length);
  assert.equal(reencoded, raw, 'compact roundtrip is byte-identical');
});

test('decode Tasmota dump captures against DataLSB and roundtrip', () => {
  let decoded = 0;
  let checked = 0;

  for (const line of captures.split(/\r?\n/)) {
    if (!line.includes('{')) continue;

    let rec: any;
    try {
      rec = JSON.parse(line).IrReceived;
    } catch {
      continue;
    }

    const orig = converter.importFormat('Tasmota', rec.RawData)[0];
    if (orig.protocol === 'UNKNOWN') continue;
    decoded++;

    if (rec.DataLSB !== undefined) {
      assert.equal(orig.data, Number(rec.DataLSB), 'decoded data matches DataLSB');
    }

    const viaCompact = converter.importFormat('Tasmota', converter.exportCode(orig, 'Tasmota'))[0];
    assert.equal(viaCompact.protocol, orig.protocol, 'compact roundtrip protocol');
    assert.equal(viaCompact.data, orig.data, 'compact roundtrip data');

    const viaComma = converter.importFormat(
      'Tasmota',
      converter.exportCode(orig, 'Tasmota', { style: 'comma' }),
    )[0];
    assert.equal(viaComma.protocol, orig.protocol, 'comma roundtrip protocol');
    assert.equal(viaComma.data, orig.data, 'comma roundtrip data');
    checked++;
  }

  assert.ok(decoded >= 6, `decoded at least 6 captures (got ${decoded})`);
  assert.ok(checked >= 6, `checked at least 6 captures (got ${checked})`);
});

test('Tasmota export of a fresh code derives timings from the protocol encoder', () => {
  const code = converter.importCode('NEC', { address: 4, command: 8 });
  const line = converter.exportCode(code, 'Tasmota', { style: 'comma', frequency: 38000 });
  assert.match(line, /^IRSend 38000,/);
  const back = converter.importFormat('Tasmota', line)[0];
  assert.equal(back.protocol, 'NEC');
  assert.equal(back.data, code.data);
});

test('multiple IrReceived objects in one log blob decode as separate signals', () => {
  const blob = [
    '{"Protocol":"NEC","Bits":32,"Data":"0x000000FF"}',
    '',
    'tele/tasmota/600605/RESULT {"IrReceived":{"Protocol":"JVC","Bits":16,"Data":"0xF98E","DataLSB":"0x9F71","Repeat":0,"RawData":"+8465-4165+570-1530Cd+575dCd+545-1560C-480EhC-1535CdChChChEdCdCdChC-17105CdCdEdCdCd+600-455ChCdEiChChChEdCdEdEhC-17100EdEdEdCdEdE-475+580nCdEdEhEnEhCdCdCdChCjCdCdCdCdCdEhChCdCdChChChCiCiCiC-485C-17110Ci+565gFgFgFgF-505+540-510T-1565TvTuT-515TuTvTvTvTuT"}}',
    'tele/tasmota/600605/RESULT {"IrReceived":{"Protocol":"JVC","Bits":16,"Data":"0xC538","DataLSB":"0xA31C","Repeat":0,"RawData":"+8470-4160+605-1500+600dE-450+575-480G-475G-1530EfGjEfGh+570jE-1505EdEfKiGhG-17105EdEdC-445GhGhGjEfGjEfGhElEdCdEfEfEfE-17080EdCdEfEfEf+580jEfCdCfEfCdCdCdCfP-470GiEoElGjE-455+595rEfE-1510GiGjGhSrGjGjKjKhKhKhKmK-1535KuKhK-485KhK-1555+545-505X-1560X-510XyXzXz+540z+540-510+540-515+540-515+540"}}',
    'tele/tasmota/600605/RESULT {"IrReceived":{"Protocol":"JVC","Bits":16,"Data":"0xC5F8","DataLSB":"0xA31F","Repeat":0,"RawData":"+8495-4135+600-1500CdC-450+575-480F-475F-1530CeFiCd+605dCdCdCdCeFgFhF-17100C-1505CdCeFhFgFiCeFiCdCdClCdCdCeCeFgC-17075ClClCeCeCe+580-1525NhCdJdJdJdJdJdJ-445CeCeFkNoFiCeFgFhNoFgFi+570iFiClFiQiQgQgQgQ"}}',
    'tele/tasmota/600605/RESULT {"IrReceived":{"Protocol":"JVC","Bits":16,"Data":"0xC578","DataLSB":"0xA31E","Repeat":0,"RawData":"+8500-4130+600-1500+605dC-450+575-475GhG-1530CfGiEfGiCdCdCdCfG-480GjG-17100C-1505CdCfCfGjGiC-455+570iCfNiClClCdCfCfGhC-17075CdClCf+580-470Ef+585-1520E-445EdEtCdCdCdClCfCfGhPkClGiCmGjGjGi+595mNiNjNiNiN-1535NiNjNjN-485+565"}}',
  ].join('\n');

  const codes = converter.importFormat('Tasmota', blob);
  assert.equal(codes.length, 5, 'the standalone object and all four IrReceived objects are found');
  assert.equal(codes[0].protocol, 'NEC');
  assert.equal(codes[0].data, 0x000000ff);
  for (const jvc of codes.slice(1)) {
    assert.equal(jvc.protocol, 'JVC', 'each IrReceived decodes to JVC');
    assert.equal(jvc.bits, 16);
  }
  const data = codes.map((c) => c.data);
  assert.deepEqual(
    data,
    [0x000000ff, 0x9f71, 0xa31c, 0xa31f, 0xa31e],
    'IrReceived DataLSB is used when present, not Data',
  );
});

test('Tasmota export defaults to compact and zero frequency', () => {
  const code = converter.importCode('NEC', { address: 4, command: 8 });
  const line = converter.exportCode(code, 'Tasmota');
  assert.match(line, /^IRSend 0,/);
  const compact = line.slice('IRSend 0,'.length);
  const back = converter.importFormat('Tasmota', compact)[0];
  assert.equal(back.protocol, 'NEC');
  assert.equal(back.data, code.data);
});

test('Tasmota json export emits both byte orders and roundtrips', () => {
  const code = converter.importCode('NEC', '0x10EF00FF');
  const jsonText = converter.exportCode(code, 'Tasmota', { style: 'json' });
  const obj = JSON.parse(jsonText);
  assert.deepEqual(
    obj,
    { Protocol: 'NEC', Bits: 32, Data: '0x08F700FF', DataLSB: '0x10EF00FF' },
    'json style carries protocol, bits, the display Data and the accumulated DataLSB',
  );

  const back = converter.importFormat('Tasmota', jsonText)[0];
  assert.equal(back.protocol, 'NEC');
  assert.equal(back.data, 0x10ef00ff, 'json output is accepted as structured input via DataLSB');
});

test('toIrsend emits Data in the display form, matching the transmitted capture', () => {
  // These pairs come from a live roundtrip through the MQTT test rig: the
  // accumulated value sent via IRSend raw and the Data field the receiver
  // reported for it.
  const cases: [string, string, boolean, string, string][] = [
    // [protocol, imported accumulated value, lsbIsAccumulated, expected data, expected Data]
    ['NEC', '0x04FB08F7', true, '0x04FB08F7', '0x20DF10EF'],
    ['NEC', '0x10EF00FF', true, '0x10EF00FF', '0x08F700FF'],
    ['JVC', '0x030C', true, '0x030C', '0xC030'],
    ['JVC-48', '0x030122210300', true, '0x030122210300', '0xC0804484C000'],
    ['SAMSUNG', '0x070702FD', true, '0x070702FD', '0xE0E040BF'],
    // Whole-word MSB-first: Data itself is the accumulated form.
    ['SAMSUNG36', '0x400ED02F', false, '0x400ED02F', '0x400ED02F'],
  ];
  for (const [proto, value, lsbIsAccumulated, expectedData, expectedDisplay] of cases) {
    const code = lsbIsAccumulated
      ? converter.importLsb(proto, value)
      : converter.importCode(proto, value);
    assert.equal(
      dataHex(code.data!),
      expectedData,
      `${proto} import yields the accumulated value`,
    );
    assert.equal(
      code.toIrsend(lsbIsAccumulated).Data,
      expectedDisplay,
      `${proto} toIrsend Data matches the transmitted display form`,
    );
  }
});

test('Tasmota protocol-structured lines import by name', () => {
  const line = '23:12:54.945 IrReceived: IRrecv: Protocol = NEC, Bits = 32, Data = 0x10EF00FF';
  const code = converter.importFormat('Tasmota', line)[0];
  assert.equal(code.protocol, 'NEC');
  assert.equal(code.data, 0x08f700ff, 'Data is the display form and decodes byte-reversed');
  assert.equal(code.alias, '0x08F700FF', 'alias defaults to the decoded data hex');
});

test('multi-signal console dump decodes supported lines and drops the rest', () => {
  const dump = [
    '17:12:31.100 IRrecv: Protocol = NEC, Bits = 32, Data = 0x10EF00FF',
    '17:12:31.200 IRrecv: RawData = +8495-4070+660-1440C-1450+620-430+655-390H-400+645-405Ci+650jHeCdC-1445+625-425M-1480OjMjCiC',
    '17:12:31.300 IRrecv: Protocol = RC5, Bits = 14, Data = 0x400',
    '17:12:31.400 IRrecv: RawData = +435-1540+440-555C-560+445-540+460-580+415d+430-1570C-1560C-585+420-1550+450-550',
    '17:12:31.500 this is just log noise',
    'IRsend 38000,9185,4490,650,500,655,500,655,1630',
  ].join('\n');

  const codes = converter.importFormat('Tasmota', dump);
  assert.equal(codes.length, 2, 'dump decodes the supported signals, drops the rest');
  assert.equal(codes[0].protocol, 'NEC', 'dump first signal is structured NEC');
  assert.equal(codes[0].alias, '0x08F700FF', 'dump NEC alias comes from its decoded display-form Data');
  assert.equal(codes[1].protocol, 'JVC', 'dump second signal is raw JVC data');
  assert.equal(codes[1].alias, '0x0317', 'dump JVC alias comes from decoded data');
});

test('JSON IrReceived lines decode via patterns, not well-formed JSON parsing', () => {
  const jsonLine =
    '{"IrReceived":{"Protocol":"NEC","Bits":32,"Data":"0x10EF00FF","DataLSB":"0x4FB09F6","Repeat":0,"RawData":"+9185-4490+650-500+655dE-1630C-505+630-525Ed+625-530H-520H-1655JmJiCfCfHmH-1650CfHmHiEdCfCdHiHiEdHiEfCfHiEfEfEfEfC-40270+9160-2235H","RawDataInfo":[71,71,0]}}';
  const [code] = converter.importFormat('Tasmota', jsonLine);
  assert.equal(code.protocol, 'NEC', 'structured fields win even inside JSON');
  assert.equal(
    code.data,
    0x04fb09f6,
    'JSON DataLSB is preferred over Data because its bytes are the transmitted address/command',
  );
});

test('RawData timings win over structured fields when both are present', () => {
  // Tasmota's own decode is the fallback: when the timings themselves
  // decodable, they are authoritative even if the Protocol/Data fields claim
  // something else (which happens when its decoder truncates or mislabels a
  // frame).
  const jsonLine =
    '{"IrReceived":{"Protocol":"JVC","Bits":16,"Data":"0x1234","Repeat":0,"RawData":"+9185-4490+650-500+655dE-1630C-505+630-525Ed+625-530H-520H-1655JmJiCfCfHmH-1650CfHmHiEdCfCdHiHiEdHiEfCfHiEfEfEfEfC-40270+9160-2235H","RawDataInfo":[71,71,0]}}';
  const [code] = converter.importFormat('Tasmota', jsonLine);
  assert.equal(code.protocol, 'NEC', 'timings are decoded as NEC, not the claimed JVC');
  assert.equal(code.data, 0x04fb09f6, 'decoded from the timings, not the claimed Data');
});

test('structured fields remain the fallback when timings do not decode', () => {
  // A frame whose trailing zero-bit bytes were swallowed mid-capture: our
  // strict MWM decoder rejects the truncated timings, so the structured
  // fields still yield the (imperfect) frame rather than dropping it.
  const jsonLine =
    '{"IrReceived":{"Protocol":"MWM","Bits":88,"Data":"0x9942000048140CCAD00E83","Repeat":0}}';
  const [code] = converter.importFormat('Tasmota', jsonLine);
  assert.equal(code.protocol, 'MWM', 'structured MWM fallback applies without RawData');
});

test('structured SAMSUNG36 captures use Data, not the DataLSB artifact', () => {
  // Real Tasmota SAMSUNG36 captures (samples/tasmota-capture.log) report
  // Data=0x400ED02F and DataLSB=0x2700BF4 for the "0" button (address
  // 0x400, command 0xED02F). SAMSUNG36 transmits the 36-bit word MSB-first,
  // so Data itself is the accumulated form decodeRaw reads; Tasmota's
  // DataLSB is only a per-byte bit reversal of the low 32 bits and must not
  // win over Data.
  const jsonLine =
    '{"IrReceived":{"Protocol":"SAMSUNG36","Bits":36,"Data":"0x400ED02F","DataLSB":"0x2700BF4","Repeat":0,"RawData":"+4585-4390+555-445C-450+550dCd+580-415G-1420G-420GjCdCdGjGjGjC-440CdGjG-4420C-1445GiFmGjFmFmFdF-1450+575-425FdGjOpOpFeFnFeFnO-1425FnFnF","RawDataInfo":[77,77,0]}}';
  const viaStructured = converter.importFormat('Tasmota', jsonLine)[0];
  assert.equal(viaStructured.protocol, 'SAMSUNG36');
  assert.equal(viaStructured.bits, 36);
  assert.equal(viaStructured.address, 0x400, 'Data decodes to the transmitted address');
  assert.equal(viaStructured.command, 0xed02f, 'Data decodes to the transmitted command');
  assert.equal(viaStructured.data, 0x400ed02f, 'data word is the Data value, not DataLSB');

  // DataLSB alone (no Data field) cannot recover the word, but when Data is
  // present it must win.
  const dataOnly =
    '{"IrReceived":{"Protocol":"SAMSUNG36","Bits":36,"Data":"0x400ED02F","Repeat":0}}';
  const viaDataOnly = converter.importFormat('Tasmota', dataOnly)[0];
  assert.equal(viaDataOnly.address, 0x400, 'Data-only capture still decodes the address');
  assert.equal(viaDataOnly.command, 0xed02f, 'Data-only capture still decodes the command');
});

test('JVC VCR structured captures decode the transmitted address/command', () => {
  // Live Tasmota JVC captures (samples/tasmota-jvc-vcr-capture.log) for the
  // 0x43-device VCR remote: "0" is Data=0xC2CC / DataLSB=0x4333.
  const jsonLine =
    '{"IrReceived":{"Protocol":"JVC","Bits":16,"Data":"0xC2CC","DataLSB":"0x4333","Repeat":0,"RawData":"+8525-4140+615-1495+610-1500E-445EgEg+605-450+580-1530J-470E-1505J-1525Hi+585l+600-1510JkJlEgO-21580Hf+590kJlEgEgEgJkJ-475JkJkOlJtJkJkJtJtJ-21585JkJkJtPiJlJtJkJ-480+575kJkJtHiJkJkPiJtP","RawDataInfo":[103,103,0]}}';
  const code = converter.importFormat('Tasmota', jsonLine)[0];
  assert.equal(code.protocol, 'JVC');
  assert.equal(code.address, 0x43, 'JVC DataLSB decodes to the transmitted address');
  assert.equal(code.command, 0x33, 'JVC DataLSB decodes to the transmitted command');
  assert.equal(code.data, 0x4333, 'data word is the accumulated DataLSB');
});

test('SAMSUNG36 json export emits Data as the accumulated field and roundtrips', () => {
  // On the wire SAMSUNG36 is the reverse of NEC/JVC/SAMSUNG: Data is the
  // accumulated form (address in the top 16 bits) and DataLSB the per-byte
  // reversal artifact. Exporting a code must not swap them.
  const code = converter.importCode('SAMSUNG36', { address: 0x400, command: 0xed02f });
  const obj = JSON.parse(converter.exportCode(code, 'Tasmota', { style: 'json' }));
  assert.deepEqual(
    obj,
    { Protocol: 'SAMSUNG36', Bits: 36, Data: '0x400ED02F', DataLSB: '0x02700BF4' },
    'SAMSUNG36 json keeps Data as the accumulated value, matching Tasmota captures',
  );

  const back = converter.importFormat('Tasmota', converter.exportCode(code, 'Tasmota', { style: 'json' }))[0];
  assert.equal(back.protocol, 'SAMSUNG36');
  assert.equal(back.address, 0x400, 'json output roundtrips the address');
  assert.equal(back.command, 0xed02f, 'json output roundtrips the command');
});

test('structured SAMSUNG captures decode DataLSB through the byte-order entry point', () => {
  // Real Tasmota SAMSUNG captures (see samples/ and the fixture log) report
  // Data=0xE0E040BF and DataLSB=0x070702FD. SAMSUNG decodeRaw expects the
  // display form, so a DataLSB value must be translated, not passed through:
  // addr/command come out as 0xE0/0x40 rather than 0x07/0x07.
  const jsonLine =
    '{"IrReceived":{"Protocol":"SAMSUNG","Bits":32,"Data":"0xE0E040BF","DataLSB":"0x70702FD","Repeat":0,"RawData":"+4615-4360+690-1560+695-1550CdC-425+700-420E-430EgCgE-1555CkCd+680-465+660jCj+685jCjCjEkCjEgEgOjEgCjCkHgCdEkCdCkEkCkH-46645+4625-4370EkCkCdCjEiEjCjEgEkCdEkL-440EiCjCjCjC-435CkCgEg+670-450UvU-445UvU-1580Uw+675xUxUx+665-1585+625-1620Z-1585Z","RawDataInfo":[135,135,0]}}';
  const viaStructured = converter.importFormat('Tasmota', jsonLine)[0];
  assert.equal(viaStructured.protocol, 'SAMSUNG');
  assert.equal(viaStructured.address, 0xe0, 'DataLSB decodes to the transmitted address');
  assert.equal(viaStructured.command, 0x40, 'DataLSB decodes to the transmitted command');
  assert.equal(viaStructured.data, 0x070702fd, 'data word matches the capture DataLSB');

  // The RawData waveform decode agrees with the structured DataLSB path.
  const viaTiming = converter.importFormat('Tasmota', JSON.parse(jsonLine).IrReceived.RawData)[0];
  assert.equal(viaTiming.address, viaStructured.address, 'RawData decode agrees with DataLSB');
  assert.equal(viaTiming.command, viaStructured.command);
  assert.equal(viaTiming.data, viaStructured.data);
});

test('pretty-printed multi-line JSON joins into one record', () => {
  const pretty = [
    'MQT: tele/sonoff/RESULT = {',
    '  "IrReceive": {',
    '    "Protocol": "NEC",',
    '    "Bits": 32,',
    '    "Data": "0x10EF00FF",',
    '    "RawData": "+9185-4490+650-500+655dE-1630C-505+630-525Ed+625-530H-520H-1655JmJiCfCfHmH-1650CfHmHiEdCfCdHiHiEdHiEfCfHiEfEfEfEfC-40270+9160-2235H"',
    '  }',
    '}',
  ].join('\n');
  const [code] = converter.importFormat('Tasmota', pretty);
  assert.equal(code.protocol, 'NEC');
  assert.equal(
    code.data,
    0x04fb09f6,
    'timings win over structured fields: the decoded word is the transmitted address/command',
  );
});

test('whitespace-tolerant loose form; unregistered protocols fall back to RawData', () => {
  const raw =
    '+9185-4490+650-500+655dE-1630C-505+630-525Ed+625-530H-520H-1655JmJiCfCfHmH-1650CfHmHiEdCfCdHiHiEdHiEfCfHiEfEfEfEfC-40270+9160-2235H';

  const loose = `IRrecv: Protocol   =   NEC  ,  Bits  =  32  ,  Data  =  0x10EF00FF , RawData = ${raw}`;
  const [byProto] = converter.importFormat('Tasmota', loose);
  assert.equal(byProto.protocol, 'NEC', 'loose structured line decodes by protocol');

  const noSpaces = 'Protocol=NEC,Bits=32,Data=0x10EF00FF';
  const [compact] = converter.importFormat('Tasmota', noSpaces);
  assert.equal(compact.data, 0x08f700ff, 'no-space structured form decodes Data as the display form');

  const denon = `IRrecv: Protocol = DENON, Bits = 15, Data = 0x1024, RawData = ${raw}`;
  const [fallback] = converter.importFormat('Tasmota', denon);
  assert.equal(fallback.protocol, 'NEC', 'unregistered protocol falls back to the RawData timing decode');
});

test('multiple JSON objects sharing one line decode to multiple signals', () => {
  const oneLine = [
    '{"IrReceived":{"Protocol":"NEC","Bits":32,"Data":"0x10EF00FF","RawData":"+9185-4490+650-500+655dE-1630C-505+630-525Ed+625-530H-520H-1655JmJiCfCfHmH-1650CfHmHiEdCfCdHiHiEdHiEfCfHiEfEfEfEfC-40270+9160-2235H"}}',
    '{"IrReceived":{"Protocol":"JVC","Bits":16,"Data":"0xC5E8","RawData":"+8520-4110+600-1505CdC-455CeC-450Cd+595eCdCdCdCdCeCdCeCfCeC-17080CdCdCfCfCeCdCfCdCdC-1500CdCfCdCe+620-430CfChCdCdCeCeCeG-1510GeGlGlGlGlG-460+590lGeGmGmN-17085NlNlNmN-480+570pQ-1530QpQ-1535QsQsQ-1540+565-490UtUvUvUvU-17115UtUtUvUv+560vX-1545U-485UtUtXtUtXvXtXvUvUvX"}}',
  ].join('');
  const codes = converter.importFormat('Tasmota', oneLine);
  assert.equal(codes.length, 2, 'two adjacent JSON objects are two signals');
  assert.equal(codes[0].protocol, 'NEC');
  assert.equal(codes[1].protocol, 'JVC');
});

test('bare RawData lines and IRsend commands decode from a dump', () => {
  const raw =
    '+9185-4490+650-500+655dE-1630C-505+630-525Ed+625-530H-520H-1655JmJiCfCfHmH-1650CfHmHiEdCfCdHiHiEdHiEfCfHiEfEfEfEfC-40270+9160-2235H';
  const dump = [
    `17:12:31.100 IRrecv: RawData = ${raw}`,
    `17:12:31.200 IRsend 38000,${raw}`,
    'noise line with no signal',
  ].join('\n');
  const codes = converter.importFormat('Tasmota', dump);
  assert.equal(codes.length, 2, 'both RawData and IRsend records decode');
  assert.equal(codes[0].protocol, 'NEC');
  assert.equal(codes[1].protocol, 'NEC', 'IRsend compact payload decodes the same');
});

test('UNKNOWN captures keep their timings and re-export verbatim', () => {
  const raw = '+435-1540+440-555C-560+445-540+460-580+415d+430-1570C-1560C-585+420-1550+450-550';
  const rawCode = converter.importFormat('Tasmota', raw)[0];
  assert.equal(rawCode.protocol, 'UNKNOWN', 'unmatched signal is tagged UNKNOWN');
  const rawOut = converter.exportCode(rawCode, 'Tasmota').replace(/^IRSend \d+,/, '');
  assert.equal(rawOut, raw, 'UNKNOWN timing data roundtrips verbatim');
});

test('comma form and IRSend frequency prefix', () => {
  const commaIn = converter.importFormat('Tasmota', '9185,4490,650,500,655,500,655,1630')[0];
  assert.equal(commaIn.protocol, 'UNKNOWN', 'short comma list is not a full frame');

  const irsend = converter.importFormat('Tasmota', 'IRsend 38000,9185,4490,650,500,655,500,655,1630')[0];
  assert.equal(irsend.protocol, 'UNKNOWN', 'IRSend frequency prefix is stripped');
});

test('live wide-protocol captures decode to the transmitted address/subaddress/command', () => {
  // Four signals encoded by our own protocol encoders, transmitted over the
  // MQTT IR test rig (Tasmota IRsend raw), and captured back by the receiver.
  // IRremoteESP8266 natively decodes SAMSUNG36 (reported Data=0x7004E50F3);
  // the 48-NEC1, JVC-48 and SAMSUNG20 frames have no native decoder there and
  // come back mis-decoded (MIDEA24/PANASONIC/UNKNOWN), so the RawData timing
  // decode is what must recover the transmitted values.
  const captures = [
    {
      label: 'SAMSUNG36',
      irs: '{"Protocol":"SAMSUNG36","Bits":36,"Data":"0x7004E50F3","DataLSB":"0xE000720ACF","Repeat":0,"RawData":"+4545-4430+535-470C-1450+540-1440CeFdFd+530-475FdCdCdCdFiCiF-1445HiCdF-4420FgCjCgFdHdFgFdFjCdCdFdF-465FgFgFjFgFdCdFgFgF","RawDataInfo":[77,77,0]}',
      want: { protocol: 'SAMSUNG36', address: 0x7004, subaddress: -1, command: 0xe50f3 },
    },
    {
      label: '48-NEC1',
      irs: '{"Protocol":"MIDEA24","Bits":24,"Data":"0xB21600","DataLSB":"0x4D6800","Repeat":0,"RawData":"+9010-4490+535-1705+540-575+590-1650CdEf+585-525I-1655IjIjIhEfG-520GhEdEfGhCfGjIjIkEfIhGhE-580IkIkIkCfGhEfGlGhIjGlGlGlGlGlGlGjIh+560-1680EdCdEdEdNoNoE","RawDataInfo":[99,99,0]}',
      want: { protocol: '48-NEC1', address: 77, subaddress: 178, command: 104 },
    },
    {
      label: 'JVC-48',
      irs: '{"Protocol":"PANASONIC","Bits":48,"Data":"0xC0804484C000","DataLSB":"0x30122210300","Repeat":0,"RawData":"+3470-1720+460-1280+455dE-420+450fE-415EhEfEhEdEfC-410CiCfEhEhEfGhCdEfEhEhEdGfEhEdEhEfEhEhEdGfGfEdEdCiCfEhEhChEfEhEhCiChEfGfGfGfE","RawDataInfo":[99,99,0]}',
      want: { protocol: 'JVC-48', address: 34, subaddress: 33, command: 3 },
    },
    {
      label: 'SAMSUNG20',
      irs: '{"Protocol":"UNKNOWN","Bits":22,"Hash":"0xFA37F15D","Repeat":0,"RawData":"+4530-4495+595-1680C-555+560cEcFcF-590Fc+580-575FcE-1720CeFgFjCdC-1675+600-550FcEjCeHiF","RawDataInfo":[43,43,0]}',
      want: { protocol: 'SAMSUNG20', address: 1, subaddress: 8, command: 39 },
    },
  ];

  for (const { label, irs, want } of captures) {
    const rec = JSON.parse(`{"IrReceived":${irs}}`).IrReceived;

    const viaTiming = converter.importFormat('Tasmota', rec.RawData)[0];
    assert.equal(viaTiming.protocol, want.protocol, `${label} RawData decodes to the protocol`);
    assert.equal(viaTiming.address, want.address, `${label} RawData decodes to the address`);
    assert.equal(viaTiming.subaddress, want.subaddress, `${label} RawData decodes to the subaddress`);
    assert.equal(viaTiming.command, want.command, `${label} RawData decodes to the command`);

    // The real captures roundtrip through the compact codec losslessly.
    const reenc = converter.exportCode(viaTiming, 'Tasmota').slice('IRSend 0,'.length);
    assert.equal(reenc, rec.RawData, `${label} compact roundtrip is byte-identical`);

    // The structured record (Protocol/Data) still decodes where a native
    // decoder reported a value (SAMSUNG36 only here).
    if (rec.Protocol === 'SAMSUNG36') {
      const viaStructured = converter.importFormat('Tasmota', JSON.stringify({ IrReceived: rec }))[0];
      assert.equal(viaStructured.data, 0x7004e50f3, `${label} structured Data decode`);
    }
  }
});

test('error handling', () => {
  assert.throws(
    () => converter.importFormat('Tasmota', ''),
    /No Tasmota RawData provided|unrecognized/i,
    'rejects empty input',
  );
  assert.throws(
    () => converter.importFormat('Tasmota', '12345'),
    /unrecognized|Unrecognized/i,
    'rejects unrecognized input',
  );
  assert.throws(
    () => converter.importFormat('Tasmota', '+100-100Z'),
    /undefined timing letter/i,
    'rejects unknown letter in compact form',
  );
  assert.throws(
    () => converter.exportCode(new IRCode({ protocol: 'UNKNOWN' }), 'Tasmota'),
    /timings|protocol encoder|Pronto/i,
    'rejects export of a code with no timings and no encodable protocol',
  );
});
