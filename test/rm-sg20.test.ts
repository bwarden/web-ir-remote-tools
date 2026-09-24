//
// RM-SG20 NEC — cross-format byte-order, value, and timing consistency.
//
// The same NEC signal (32-bit, address 131 = 0x83, subaddress 0) exists in
// three formats under samples/rm-sg20/ and must import to one identical code:
//
//  131,0.csv               IRDB row (functionname,protocol,device,subdevice,
//                          function) — command via decimal numeric columns.
//  RM-SG20.lircd.conf      WinLIRC/Sony remote, bits 16, pre_data 0xC100 with
//                          codes-section 16-bit values (e.g. KEY_POWER 0x00FF).
//  b0c3d8e523722ae5.json   a "Memorex 32 Bit" (= NEC) capture whose per-button
//                          Pronto Hex is embedded below. The json itself is
//                          NOT committed; only the hex it carries is.
//
// NEC transmits every byte LSB-first, so the receiver's accumulated word
// (Tasmota "Data", the json keycode value) is the per-byte bit reversal of the
// display form (Tasmota "DataLSB", our IRCode.data). pre_data 0xC100 + value
// 0xXXXX packs 0xC100XXXX in accumulated order; the display form is
// 0x8300XXXX (address 131, subaddress 0). All three importers must land on the
// same display form, and re-exporting to Tasmota (Data + DataLSB) and Pronto
// (its timing words) must give identical strings from every source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Converter } from '../src/lib/converter.js';
import { bitReverseBytes } from '../src/lib/code.js';

const converter = new Converter();

const rmSg20IrdbCsv = String.raw`functionname,protocol,device,subdevice,function
KEY_POWER,NEC,131,0,0
KEY_VOLUMEUP,NEC,131,0,2
KEY_VOLUMEDOWN,NEC,131,0,3
KEY_TAPE,NEC,131,0,5
Band,NEC,131,0,7
Phono,NEC,131,0,11
Preset+,NEC,131,0,76
Preset-,NEC,131,0,77
KEY_SLEEP,NEC,131,0,83
DBFB,NEC,131,0,84
PresetEq,NEC,131,0,85
KEY_TIME,NEC,131,0,93
Program,NEC,131,0,140
Shuffle,NEC,131,0,141
MScan,NEC,131,0,142
KEY_PLAY,NEC,131,0,146
KEY_STOP,NEC,131,0,147
KEY_NEXT,NEC,131,0,148
KEY_PREVIOUS,NEC,131,0,149
KEY_CLEAR,NEC,131,0,154
KEY_AGAIN,NEC,131,0,155
KEY_TIME,NEC,131,0,156
Discskip,NEC,131,0,192
`;

const rmSg20LircConf = String.raw`#
# this config file was automatically generated
# using WinLIRC 0.6.5 (LIRC 0.6.1pre3) on Mon Apr 26 18:59:58 2004
#
# contributed by
#
# brand:             Sony
# model:             RM-SG20
# supported devices:
#

begin remote

  name  RM-SG20
  bits           16
  flags SPACE_ENC
  eps            25
  aeps          100

  header       9102  4396
  one           638  1586
  zero          638   462
  ptrail        638
  pre_data_bits   16
  pre_data       0xC100
  gap          45584
  toggle_bit      0


      begin codes
          KEY_TIME                 0x000000000000BA45        #  Was: Clock
          KEY_SLEEP                0x000000000000CA35        #  Was: Sleep
          KEY_POWER                0x00000000000000FF        #  Was: Power
          Band                     0x000000000000E01F
          Preset-                  0x000000000000B24D
          Preset+                  0x00000000000032CD
          KEY_PLAY                 0x00000000000049B6        #  Was: Play
          KEY_STOP                 0x000000000000C936        #  Was: Stop
          KEY_PREVIOUS             0x000000000000A956        #  Was: Previous
          KEY_NEXT                 0x00000000000029D6        #  Was: Next
          KEY_AGAIN                0x000000000000D926        #  Was: Repeat
          KEY_TIME                 0x00000000000039C6        #  Was: Time
          Discskip                 0x00000000000003FC
          MScan                    0x000000000000718E
          Shuffle                  0x000000000000B14E
          Program                  0x00000000000031CE
          KEY_CLEAR                0x00000000000059A6        #  Was: Clear
          KEY_TAPE                 0x000000000000A05F        #  Was: Tape
          DBFB                     0x0000000000002AD5
          PresetEq                 0x000000000000AA55
          Phono                    0x000000000000D02F
          KEY_VOLUMEUP             0x00000000000040BF        #  Was: Vol+
          KEY_VOLUMEDOWN           0x000000000000C03F        #  Was: Vol-
      end codes

end remote


`;

const rmSg20GcJson = String.raw`{"commands": [
{"keycode":"G:Memorex 32 Bit:()(0xC100E01F)():3","name":"AmFmToggle","pronto":"0000 006D 0022 0000 0156 00AB 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 0663","protocol":"Memorex 32 Bit"},
{"keycode":"G:Memorex 32 Bit:()(0xC100BA45)():3","name":"Clocklight","pronto":"0000 006D 0022 0000 0156 00AB 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 003D 0017 003D 0017 003D 0017 0013 0017 003D 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 003D 0017 0663","protocol":"Memorex 32 Bit"},
{"keycode":"G:Memorex 32 Bit:()(0xC1006996)():3","name":"FastForward","pronto":"0000 006D 0022 0000 0156 00AB 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 003D 0017 0013 0017 003D 0017 0013 0017 0013 0017 003D 0017 003D 0017 0013 0017 0013 0017 003D 0017 0013 0017 003D 0017 003D 0017 0013 0017 0663","protocol":"Memorex 32 Bit"},
{"keycode":"G:Memorex 32 Bit:()(0xC10049B6)():3","name":"InputAudio","pronto":"0000 006D 0022 0000 0156 00AB 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 003D 0017 003D 0017 0013 0017 003D 0017 003D 0017 0013 0017 003D 0017 003D 0017 0013 0017 0663","protocol":"Memorex 32 Bit"},
{"keycode":"G:Memorex 32 Bit:()(0xC10009F6)():3","name":"InputCd","pronto":"0000 006D 0022 0000 0156 00AB 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 0013 0017 003D 0017 003D 0017 0013 0017 0663","protocol":"Memorex 32 Bit"},
{"keycode":"G:Memorex 32 Bit:()(0xC10010EF)():3","name":"InputCd2","pronto":"0000 006D 0022 0000 0156 00AB 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 003D 0017 003D 0017 0013 0017 003D 0017 003D 0017 003D 0017 003D 0017 0663","protocol":"Memorex 32 Bit"},
{"keycode":"G:Memorex 32 Bit:()(0xC10030CF)():3","name":"InputNext","pronto":"0000 006D 0022 0000 0156 00AB 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 003D 0017 0013 0017 0013 0017 003D 0017 003D 0017 003D 0017 003D 0017 0663","protocol":"Memorex 32 Bit"},
{"keycode":"G:Memorex 32 Bit:()(0xC100D02F)():3","name":"InputPhono","pronto":"0000 006D 0022 0000 0156 00AB 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 003D 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 003D 0017 003D 0017 003D 0017 003D 0017 0663","protocol":"Memorex 32 Bit"},
{"keycode":"G:Memorex 32 Bit:()(0xC1000BF4)():3","name":"InputTape","pronto":"0000 006D 0022 0000 0156 00AB 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 0013 0017 003D 0017 0013 0017 0013 0017 0663","protocol":"Memorex 32 Bit"},
{"keycode":"G:Memorex 32 Bit:()(0xC100A05F)():3","name":"InputTape2","pronto":"0000 006D 0022 0000 0156 00AB 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 0663","protocol":"Memorex 32 Bit"},
{"keycode":"G:Memorex 32 Bit:()(0xC10029D6)():3","name":"NextTrack","pronto":"0000 006D 0022 0000 0156 00AB 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 003D 0017 0013 0017 0013 0017 003D 0017 003D 0017 003D 0017 0013 0017 003D 0017 0013 0017 003D 0017 003D 0017 0013 0017 0663","protocol":"Memorex 32 Bit"},
{"keycode":"G:Memorex 32 Bit:()(0xC1009966)():3","name":"Pause","pronto":"0000 006D 0022 0000 0156 00AB 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 003D 0017 003D 0017 0013 0017 0013 0017 003D 0017 0013 0017 003D 0017 003D 0017 0013 0017 0013 0017 003D 0017 003D 0017 0013 0017 0663","protocol":"Memorex 32 Bit"},
{"keycode":"G:Memorex 32 Bit:()(0xC100AB54)():3","name":"Play","pronto":"0000 006D 0022 0000 0156 00AB 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 003D 0017 0013 0017 003D 0017 0013 0017 003D 0017 003D 0017 0013 0017 003D 0017 0013 0017 003D 0017 0013 0017 003D 0017 0013 0017 0013 0017 0663","protocol":"Memorex 32 Bit"},
{"keycode":"G:Memorex 32 Bit:()(0xC10000FF)():3","name":"PowerToggle","pronto":"0000 006D 0022 0000 0156 00AB 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 0663","protocol":"Memorex 32 Bit"},
{"keycode":"G:Memorex 32 Bit:()(0xC100A956)():3","name":"PreviousTrack","pronto":"0000 006D 0022 0000 0156 00AB 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 003D 0017 0013 0017 003D 0017 0013 0017 0013 0017 003D 0017 0013 0017 003D 0017 0013 0017 003D 0017 0013 0017 003D 0017 003D 0017 0013 0017 0663","protocol":"Memorex 32 Bit"},
{"keycode":"G:Memorex 32 Bit:()(0xC100E916)():3","name":"Rewind","pronto":"0000 006D 0022 0000 0156 00AB 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 003D 0017 003D 0017 0013 0017 003D 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 003D 0017 003D 0017 0013 0017 0663","protocol":"Memorex 32 Bit"},
{"keycode":"G:Memorex 32 Bit:()(0xC10059A6)():3","name":"Stop","pronto":"0000 006D 0022 0000 0156 00AB 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 003D 0017 003D 0017 0013 0017 0013 0017 003D 0017 003D 0017 0013 0017 003D 0017 0013 0017 0013 0017 003D 0017 003D 0017 0013 0017 0663","protocol":"Memorex 32 Bit"},
{"keycode":"G:Memorex 32 Bit:()(0xC100AA55)():3","name":"SurroundOn/Off","pronto":"0000 006D 0022 0000 0156 00AB 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 003D 0017 0013 0017 003D 0017 0013 0017 003D 0017 0013 0017 0013 0017 003D 0017 0013 0017 003D 0017 0013 0017 003D 0017 0013 0017 003D 0017 0663","protocol":"Memorex 32 Bit"},
{"keycode":"G:Memorex 32 Bit:()(0xC1007887)():3","name":"SurroundToggle","pronto":"0000 006D 0022 0000 0156 00AB 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 003D 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 003D 0017 003D 0017 0663","protocol":"Memorex 32 Bit"},
{"keycode":"G:Memorex 32 Bit:()(0xC100C837)():3","name":"VolumeCenterDown","pronto":"0000 006D 0022 0000 0156 00AB 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 003D 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 003D 0017 0013 0017 003D 0017 003D 0017 003D 0017 0663","protocol":"Memorex 32 Bit"},
{"keycode":"G:Memorex 32 Bit:()(0xC10048B7)():3","name":"VolumeCenterUp","pronto":"0000 006D 0022 0000 0156 00AB 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 003D 0017 003D 0017 0013 0017 003D 0017 003D 0017 003D 0017 0663","protocol":"Memorex 32 Bit"},
{"keycode":"G:Memorex 32 Bit:()(0xC100C03F)():3","name":"VolumeDown","pronto":"0000 006D 0022 0000 0156 00AB 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 0663","protocol":"Memorex 32 Bit"},
{"keycode":"G:Memorex 32 Bit:()(0xC10040BF)():3","name":"VolumeUp","pronto":"0000 006D 0022 0000 0156 00AB 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 0663","protocol":"Memorex 32 Bit"}
]}
`;


const loadIrdb = () => converter.importFormat('CSV', rmSg20IrdbCsv);
const loadLirc = () => converter.importFormat('LIRC', rmSg20LircConf);

const ADDR = 0x83; // 131
const BASE = (ADDR << 24) | (0 << 16); // display bytes: address, subaddress 0

// The NEC display word for address 131/subaddress 0: command byte, its one's
// complement in the fourth byte.
const displayFor = (cmd: number) => (BASE | ((cmd & 0xff) << 8) | (~cmd & 0xff)) >>> 0;

interface Button {
  name: string; // label for failure messages
  alias: string; // alias used by the IRDB CSV and the LIRC conf
  capture: string; // button name in the json capture
  command: number; // IRDB function column and LIRC/Pronto decoded command
  accumulated: number; // the json keycode value (Tasmota Data / LSB-receiver word)
  pronto: string; // Pronto Hex embedded from the (uncommitted) json capture
}

const buttons: Button[] = [
  {
    name: 'Power',
    alias: 'KEY_POWER',
    capture: 'PowerToggle',
    command: 0,
    accumulated: 0xc10000ff,
    pronto: `0000 006D 0022 0000 0156 00AB 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 0663`,
  },
  {
    name: 'Volume Up',
    alias: 'KEY_VOLUMEUP',
    capture: 'VolumeUp',
    command: 2,
    accumulated: 0xc10040bf,
    pronto: `0000 006D 0022 0000 0156 00AB 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 0663`,
  },
  {
    name: 'Volume Down',
    alias: 'KEY_VOLUMEDOWN',
    capture: 'VolumeDown',
    command: 3,
    accumulated: 0xc100c03f,
    pronto: `0000 006D 0022 0000 0156 00AB 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 0663`,
  },
  {
    name: 'Tape',
    alias: 'KEY_TAPE',
    capture: 'InputTape2',
    command: 5,
    accumulated: 0xc100a05f,
    pronto: `0000 006D 0022 0000 0156 00AB 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 0663`,
  },
  {
    name: 'Band',
    alias: 'Band',
    capture: 'AmFmToggle',
    command: 7,
    accumulated: 0xc100e01f,
    pronto: `0000 006D 0022 0000 0156 00AB 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 0663`,
  },
  {
    name: 'Phono',
    alias: 'Phono',
    capture: 'InputPhono',
    command: 11,
    accumulated: 0xc100d02f,
    pronto: `0000 006D 0022 0000 0156 00AB 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 003D 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 003D 0017 003D 0017 003D 0017 003D 0017 0663`,
  },
];

const NEC_PRONTO_HEAD = '0000 006D 0022 0000'; // 38 kHz, 34 burst pairs

for (const btn of buttons) {
  test(`RM-SG20 ${btn.name}: IRDB/LIRC/Pronto agree on NEC fields, data, datalsb`, () => {
    const irdb = loadIrdb().find((c) => c.alias === btn.alias);
    const lirc = loadLirc().find((c) => c.alias === btn.alias);
    const pronto = converter.importFormat('Pronto', btn.pronto).pop()!;
    assert.ok(irdb, `IRDB row ${btn.alias}`);
    assert.ok(lirc, `LIRC button ${btn.alias}`);
    assert.ok(pronto, 'Pronto decodes to a code');

    const display = displayFor(btn.command);
    const datalsb = bitReverseBytes(display, 32);

    for (const [src, code] of [
      ['IRDB', irdb],
      ['LIRC', lirc],
      ['Pronto', pronto],
    ] as const) {
      assert.equal(code.protocol, 'NEC', `${src} protocol`);
      assert.equal(code.bits, 32, `${src} bits`);
      assert.equal(code.address, ADDR, `${src} address`);
      assert.equal(code.subaddress, 0, `${src} sub-address`);
      assert.equal(code.command, btn.command, `${src} command`);
      assert.equal(code.data, display, `${src} data (display form)`);
      assert.equal(bitReverseBytes(code.data as number, code.bits), datalsb, `${src} datalsb`);
      assert.equal(datalsb, btn.accumulated, `${src} datalsb equals the capture's accumulated word`);
    }

    // Converting every source to Tasmota JSON emits the identical Data/DataLSB
    // pair, and converting to Pronto emits the identical timing encoding.
    const tasmota = (c: typeof irdb) => converter.exportCode(c, 'Tasmota', { style: 'json' }).trim();
    const taskTxt = tasmota(irdb);
    assert.equal(tasmota(lirc), taskTxt, 'Tasmota export: IRDB == LIRC');
    assert.equal(tasmota(pronto), taskTxt, 'Tasmota export: IRDB == Pronto');
    assert.match(taskTxt, new RegExp(`"Data":"0x${btn.accumulated.toString(16).toUpperCase().padStart(8, '0')}"`));
    assert.match(taskTxt, new RegExp(`"DataLSB":"0x${display.toString(16).toUpperCase().padStart(8, '0')}"`));

    const prontoOut = (c: typeof irdb) => converter.exportCode(c, 'Pronto').trim();
    const prTxt = prontoOut(irdb);
    assert.equal(prontoOut(lirc), prTxt, 'Pronto export: IRDB == LIRC');
    assert.equal(prontoOut(pronto), prTxt, 'Pronto export: IRDB == Pronto');
    assert.match(prTxt, /^0000 006D 0022 0000 /, 'Pronto export keeps the 38 kHz / 34-pair NEC framing');

    // The Pronto round-trip is stable: exporting and re-importing preserves
    // every field, so the timings encode the same code from every source.
    const round = converter.importFormat('Pronto', prTxt).pop()!;
    assert.equal(round.address, ADDR);
    assert.equal(round.subaddress, 0);
    assert.equal(round.command, btn.command);
    assert.equal(round.data, display);
  });
}

// The Global Caché json export was embedded below from a workspace-only capture
// (its per-button hex is also carried as literals above); the GCIR and wig
// entry points must parse it interchangeably.
test('RM-SG20 GC json imports in place of the embedded hex', () => {
  const viaGc = converter.importFormat('GCIR', rmSg20GcJson);
  const viaWig = converter.importFormat('wig', rmSg20GcJson);
  assert.deepEqual(viaWig, viaGc, 'wig entry point imports the GC export interchangeably');

  for (const btn of buttons) {
    const code = viaGc.find((c) => c.alias === btn.capture);
    assert.ok(code, `GC import has ${btn.capture}`);
    assert.equal(code.protocol, 'NEC', `${btn.capture} protocol`);
    assert.equal(code.address, ADDR, `${btn.capture} address`);
    assert.equal(code.command, btn.command, `${btn.capture} command`);
    assert.equal(code.data, displayFor(btn.command) >>> 0, `${btn.capture} display-form data`);
    assert.equal(bitReverseBytes(code.data as number, code.bits), btn.accumulated, `${btn.capture} datalsb matches the keycode word`);
  }
});