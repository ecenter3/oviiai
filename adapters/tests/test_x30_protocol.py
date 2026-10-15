import struct

from deep_x30 import protocol as p


def test_header_layout_matches_sdk():
    frame = p.encode_frame("<a/>", seq=0x1234)
    assert frame[:4] == b"\xeb\x90\xeb\x90"
    assert struct.unpack_from("<H", frame, 4)[0] == 4          # body length, little endian
    assert struct.unpack_from("<H", frame, 6)[0] == 0x1234     # sequence
    assert frame[8:16] == b"\x00" * 8
    assert frame[16:] == b"<a/>"
    assert p.HEADER_SIZE == 16


def test_decoder_handles_split_and_garbage():
    f1 = p.encode_frame("<x>1</x>", 1)
    f2 = p.encode_frame("<x>2</x>", 2)
    dec = p.FrameDecoder()
    stream = b"\x00\x01garbage" + f1 + f2
    out = []
    for i in range(0, len(stream), 5):     # 每次只餵 5 byte
        out += dec.feed(stream[i:i + 5])
    assert out == [(1, "<x>1</x>"), (2, "<x>2</x>")]


def test_build_simple_has_type_and_empty_items():
    body = p.build_simple(p.TYPE_STATUS)
    assert "<Type>1002</Type>" in body and "<Command>1</Command>" in body and "<Items/>" in body
    assert p.parse_type(body) == 1002


def test_build_nav_one_items_block_per_point():
    pts = [p.NavigationPoint(posX=1.234567891, posY=-2, value=1),
           p.NavigationPoint(posX=3, posY=4, value=2, pointInfo=1)]
    body = p.build_nav(pts)
    assert body.count("<Items>") == 2
    assert "<PosX>1.23457</PosX>" in body       # 6 significant digits like C++ ostream
    assert "<MapId>0</MapId>" in body
    assert p.parse_type(body) == 1003


def test_route_json_keys():
    pt = p.NavigationPoint.from_route_json({"PosX": 1.0, "PosY": 2.0, "MapID": 3, "PointInfo": 1, "Value": 7})
    assert (pt.posX, pt.posY, pt.mapId, pt.pointInfo, pt.value) == (1.0, 2.0, 3, 1, 7)


def test_parse_status():
    xml = ('<?xml version="1.0"?><PatrolDevice><Type>1002</Type><Items><PosX>1.5</PosX><PosY>-2</PosY>'
           "<Electricity>76</Electricity><Location>1</Location><ChargeState>1</ChargeState>"
           "<X0>9</X0><H>3</H></Items></PatrolDevice>")
    s = p.parse_status(xml)
    assert s.posX == 1.5 and s.posY == -2.0 and s.electricity == 76
    assert s.location == 1 and s.chargeState == 1 and s.x0 == 9.0 and s.h == 3


def test_parse_nav_result():
    xml = "<PatrolDevice><Type>1003</Type><Items><Value>2</Value><ErrorCode>1</ErrorCode>" \
          "<ErrorStatus>41730</ErrorStatus></Items></PatrolDevice>"
    r = p.parse_nav_result(xml)
    assert (r.value, r.errorCode, r.errorStatus) == (2, 1, 41730)
    assert p.ERROR_STATUS[41730] == "電量過低"
