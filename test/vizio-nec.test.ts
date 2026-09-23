//
// Vizio N/A NEC Power — byte-order regression.
//
// The SAME Vizio NEC Power signal (once, the real Pronto) is imported from
// three formats. LIRC NEC KEY_POWER traditionally came in accumulated form
// (pre_data 0x20DF, value 0x10EF, full 0x20DF10EF, address=32 command=16),
// while WIG and CodesCSV decode the identical signal to display form
// (address=4 subaddress=-1 command=8, data 0x04FB08F7). All NEC sources
// MUST converge on the display form and export identical Tasmota/Pronto.
//
// Ground truth from samples/: lirc-vizio-LCD_TV.lircd.conf (KEY_POWER,
// pre_data 0x20DF value 0x10EF), vizio.wig.json (Power), and
// irdb-vizio-Unknown_Vizio-4,-1.csv (NEC,4,-1,8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Converter } from '../src/lib/converter.js';
import type { IRCode } from '../src/lib/code.js';

const converter = new Converter();

const vizioLcdTvLirc = String.raw`#
# this config file was automatically generated
# using lirc-0.8.5-CVS(default) on Thu Apr  9 18:12:26 2009
#
# contributed by
#
# brand:                       Vizio remote
# model no. of remote control: 0980-0305-3000
# devices being controlled by this remote:
#

begin remote

  name  Vizio
  bits           16
  flags SPACE_ENC
  eps            30
  aeps          100

  header       8966  4400
  one           567  1596
  zero          567   494
  ptrail        575
  repeat       9000  2194
  pre_data_bits   16
  pre_data       0x20DF
  gap          40403
  repeat_gap   95450
  toggle_bit_mask 0x0

      begin codes
          KEY_INFO                 0x38C7                    #  Was: Guide
          AV                       0x8A75
          COMP                     0x5AA5
          HDMI                     0x639C
          KEY_UP                   0xA25D                    #  Was: UP
          KEY_TV                   0x6B94                    #  Was: TV
          KEY_LEFT                 0xE21D                    #  Was: LEFT
          KEY_DOWN                 0x629D                    #  Was: DOWN
          KEY_RIGHT                0x12ED                    #  Was: RIGHT
          KEY_MENU                 0xC23D                    #  Was: MENU
          KEY_MUTE                 0x906F                    #  Was: MUTE
          KEY_LAST                 0x58A7                    #  Was: LAST
          KEY_VOLUMEUP             0x40BF                    #  Was: VOL_UP
          VOL_DWN                  0xC03F
          KEY_CHANNELUP            0x00FF                    #  Was: CH_UP
          CH_DWN                   0x807F
          KEY_1                    0x8877                    #  Was: ONE
          KEY_2                    0x48B7                    #  Was: TWO
          KEY_3                    0xC837                    #  Was: THREE
          KEY_4                    0x28D7                    #  Was: FOUR
          KEY_5                    0xA857                    #  Was: FIVE
          KEY_6                    0x6897                    #  Was: SIX
          KEY_7                    0xE817                    #  Was: SEVEN
          KEY_8                    0x18E7                    #  Was: EIGHT
          KEY_9                    0x9867                    #  Was: NINE
          KEY_0                    0x08F7                    #  Was: ZERO
          INPUT                    0xF40B
          DASH                     0xFF00
          KEY_POWER                0x10EF                    #  Was: POWER
      end codes

end remote


`;

const vizioIrdbCsv = String.raw`functionname,protocol,device,subdevice,function
KEY_CHANNELUP,NEC,4,-1,0
CH_DWN,NEC,4,-1,1
KEY_VOLUMEUP,NEC,4,-1,2
VOL_DWN,NEC,4,-1,3
KEY_POWER,NEC,4,-1,8
KEY_MUTE,NEC,4,-1,9
KEY_0,NEC,4,-1,16
KEY_1,NEC,4,-1,17
KEY_2,NEC,4,-1,18
KEY_3,NEC,4,-1,19
KEY_4,NEC,4,-1,20
KEY_5,NEC,4,-1,21
KEY_6,NEC,4,-1,22
KEY_7,NEC,4,-1,23
KEY_8,NEC,4,-1,24
KEY_9,NEC,4,-1,25
KEY_LAST,NEC,4,-1,26
KEY_INFO,NEC,4,-1,28
INPUT,NEC,4,-1,47
KEY_MENU,NEC,4,-1,67
KEY_UP,NEC,4,-1,69
KEY_DOWN,NEC,4,-1,70
KEY_LEFT,NEC,4,-1,71
KEY_RIGHT,NEC,4,-1,72
AV,NEC,4,-1,81
COMP,NEC,4,-1,90
HDMI,NEC,4,-1,198
KEY_TV,NEC,4,-1,214
DASH,NEC,4,-1,255
`;

const vizioPowerWig = JSON.stringify({"format": "hair-wig/1", "name": "Vizio TV", "brand": "Vizio", "origin": "library", "signals": [{"alias": "Power", "pronto": "0000 006D 0022 0000 0156 00AB 0015 0015 0015 0015 0015 0040 0015 0015 0015 0015 0015 0015 0015 0015 0015 0015 0015 0040 0015 0040 0015 0015 0015 0040 0015 0040 0015 0040 0015 0040 0015 0040 0015 0015 0015 0015 0015 0015 0015 0040 0015 0015 0015 0015 0015 0015 0015 0015 0015 0040 0015 0040 0015 0040 0015 0015 0015 0040 0015 0040 0015 0040 0015 0040 0015 0000"}]});


const loadLirc = (text: string) => converter.importFormat('LIRC', text);
const loadWig = (text: string) => converter.importFormat('WIG', text);
const loadIrdb = (text: string) => converter.importFormat('CSV', text);

test('LIRC NEC KEY_POWER decodes Vizio Power to 4,-1,8 (0x04FB08F7), not 32,-1,16', () => {
  const power = loadLirc(vizioLcdTvLirc).find((c) => c.alias === 'KEY_POWER');
  assert.ok(power, 'KEY_POWER imported from LIRC');
  assert.equal(power.protocol, 'NEC');
  assert.equal(power.bits, 32);
  assert.equal(power.address, 4);
  assert.equal(power.subaddress, -1);
  assert.equal(power.command, 8);
  assert.equal(power.data, 0x04FB08F7);
});

test('LIRC/IDB/WIG NEC Power exports identical Tasmota and Pronto', () => {
  const lirc = loadLirc(vizioLcdTvLirc).find((c) => c.alias === 'KEY_POWER');
  const wig = loadWig(vizioPowerWig).find((c) => c.alias === 'Power');
  const irdb = loadIrdb(vizioIrdbCsv).find((c) => c.alias === 'KEY_POWER');
  assert.ok(lirc, 'LIRC KEY_POWER');
  assert.ok(wig, 'WIG KEY_POWER');
  assert.ok(irdb, 'IRDB KEY_POWER');

  const tasmota = (code: IRCode) => converter.exportCode(code, 'Tasmota').trim();
  const pronto = (code: IRCode) => converter.exportCode(code, 'Pronto').trim();
  assert.equal(tasmota(lirc), tasmota(wig));
  assert.equal(tasmota(wig), tasmota(irdb));
  assert.equal(pronto(lirc), pronto(wig));
  assert.equal(pronto(wig), pronto(irdb));
});
