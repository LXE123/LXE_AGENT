import os
import io
import tempfile
import unittest
import zipfile
from xml.etree import ElementTree as ET

from services import feishu_stock_sync as sync
from PIL import Image


CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/cellimages.xml" ContentType="application/vnd.wps-officedocument.cellimage+xml"/>
</Types>"""
WORKBOOK = """<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="目标" sheetId="1" r:id="rId1"/><sheet name="保留" sheetId="2" r:id="rId2"/></sheets>
</workbook>"""
WORKBOOK_RELS = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="sharedStrings" Target="sharedStrings.xml"/>
  <Relationship Id="rId4" Type="cellimages" Target="cellimages.xml"/>
</Relationships>"""
SHARED_STRINGS = """<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <si><t>编号</t></si><si><t>产品图片</t></si><si><t>名称</t></si><si><t>商品</t></si>
</sst>"""
TARGET_SHEET = """<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="inlineStr"><is><t>判断热销</t></is></c></row>
    <row r="2"><c r="A2"><v>100</v></c><c r="B2"><f>DISPIMG("id1")</f></c><c r="C2" t="s"><v>3</v></c><c r="D2"><f>DISPIMG("stray")</f></c></row>
  </sheetData>
</worksheet>"""
PLAIN_SHEET = """<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData><row r="1"><c r="A1"><v>keep</v></c></row></sheetData>
</worksheet>"""
DISPIMG_SHEET = PLAIN_SHEET.replace("<v>keep</v>", "<f>DISPIMG(\"other\")</f>")
CELLIMAGES = """<?xml version="1.0" encoding="UTF-8"?>
<cellImages xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <pic r:embed="rId1"/><pic r:embed="rId2"/>
</cellImages>"""
CELLIMAGE_RELS = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="image" Target="media/image1.png"/>
  <Relationship Id="rId2" Type="image" Target="media/image2.png"/>
</Relationships>"""
DRAWING_RELS = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="image" Target="../media/image2.png"/>
</Relationships>"""


def make_xlsx(path, remaining_dispimg=False, reserved_fallback=False):
    workbook = WORKBOOK
    workbook_rels = WORKBOOK_RELS
    content_types = CONTENT_TYPES
    if reserved_fallback:
        workbook = workbook.replace(
            "</sheets>",
            '<sheet name="WpsReserved_CellImgList" sheetId="3" state="veryHidden" r:id="rId5"/></sheets>',
        )
        workbook_rels = workbook_rels.replace(
            "</Relationships>",
            '<Relationship Id="rId5" Type="worksheet" Target="worksheets/sheet3.xml"/></Relationships>',
        )
        content_types = content_types.replace(
            "</Types>",
            '<Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
        )
    parts = {
        "[Content_Types].xml": content_types,
        "xl/workbook.xml": workbook,
        "xl/_rels/workbook.xml.rels": workbook_rels,
        "xl/sharedStrings.xml": SHARED_STRINGS,
        "xl/worksheets/sheet1.xml": TARGET_SHEET,
        "xl/worksheets/sheet2.xml": DISPIMG_SHEET if remaining_dispimg else PLAIN_SHEET,
        "xl/cellimages.xml": CELLIMAGES,
        "xl/_rels/cellimages.xml.rels": CELLIMAGE_RELS,
        "xl/drawings/_rels/drawing1.xml.rels": DRAWING_RELS,
        "xl/media/image1.png": b"cell-only",
        "xl/media/image2.png": b"also-drawing",
    }
    if reserved_fallback:
        parts.update({
            "xl/worksheets/sheet3.xml": PLAIN_SHEET.replace(
                "</worksheet>",
                '<drawing xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/></worksheet>',
            ),
            "xl/worksheets/_rels/sheet3.xml.rels": """<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="drawing" Target="../drawings/drawing3.xml"/></Relationships>""",
            "xl/drawings/drawing3.xml": "<drawing/>",
            "xl/drawings/_rels/drawing3.xml.rels": """<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="image" Target="../media/image1.png"/></Relationships>""",
        })
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in parts.items():
            archive.writestr(name, data)


def cell_values(xml):
    root = ET.fromstring(xml)
    return {
        cell.get("r"): "".join(node.text or "" for node in cell.iter() if node is not cell)
        for cell in root.iter()
        if sync._local_name(cell.tag) == "c"
    }


class ProcessXlsxTest(unittest.TestCase):
    def test_clears_columns_and_only_removes_unshared_cellimage_media(self):
        with tempfile.TemporaryDirectory() as folder:
            source = os.path.join(folder, "source.xlsx")
            output = os.path.join(folder, "output.xlsx")
            make_xlsx(source)

            columns, extra, media, _, kept, compressed = sync.process_xlsx(source, output, "目标")
            self.assertEqual(compressed, 0)

            self.assertEqual((columns, extra, media, kept), (1, 1, 1, False))
            with zipfile.ZipFile(output) as archive:
                names = set(archive.namelist())
                values = cell_values(archive.read("xl/worksheets/sheet1.xml"))
                self.assertEqual(values["A1"], "")
                self.assertEqual(values["A2"], "")
                self.assertEqual(values["B1"], "")
                self.assertEqual(values["B2"], "")
                self.assertEqual(values["C1"], "2")
                self.assertEqual(values["C2"], "3")
                self.assertEqual(values["D1"], "判断热销")
                self.assertEqual(values["D2"], "")
                self.assertNotIn("xl/cellimages.xml", names)
                self.assertNotIn("xl/media/image1.png", names)
                self.assertIn("xl/media/image2.png", names)
                self.assertNotIn(b"cellimages", archive.read("xl/_rels/workbook.xml.rels").lower())
            self.assertTrue(zipfile.is_zipfile(source))

    def test_keeps_all_cellimages_when_another_sheet_still_uses_dispimg(self):
        with tempfile.TemporaryDirectory() as folder:
            source = os.path.join(folder, "source.xlsx")
            output = os.path.join(folder, "output.xlsx")
            make_xlsx(source, remaining_dispimg=True)

            _, extra, media, _, kept, _ = sync.process_xlsx(source, output, "目标")

            self.assertEqual((extra, media, kept), (1, 0, True))
            with zipfile.ZipFile(output) as archive:
                names = set(archive.namelist())
                self.assertIn("xl/cellimages.xml", names)
                self.assertIn("xl/media/image1.png", names)
                self.assertIn("xl/media/image2.png", names)

    def test_removes_hidden_wps_fallback_drawing(self):
        with tempfile.TemporaryDirectory() as folder:
            source = os.path.join(folder, "source.xlsx")
            output = os.path.join(folder, "output.xlsx")
            make_xlsx(source, reserved_fallback=True)

            _, _, media, _, kept, _ = sync.process_xlsx(source, output, "目标")

            self.assertEqual((media, kept), (1, False))
            with zipfile.ZipFile(output) as archive:
                names = set(archive.namelist())
                self.assertNotIn("xl/drawings/drawing3.xml", names)
                self.assertNotIn("xl/drawings/_rels/drawing3.xml.rels", names)
                self.assertNotIn("xl/worksheets/_rels/sheet3.xml.rels", names)
                self.assertNotIn(b"<drawing", archive.read("xl/worksheets/sheet3.xml"))

    def test_vietnam_thumbnails_preserve_other_sheet_and_references(self):
        with tempfile.TemporaryDirectory() as folder:
            fixture = os.path.join(folder, "fixture.xlsx")
            source = os.path.join(folder, "source.xlsx")
            output = os.path.join(folder, "output.xlsx")
            make_xlsx(fixture, remaining_dispimg=True)
            picture = io.BytesIO()
            Image.new("RGB", (400, 400), "red").save(picture, "PNG")
            with zipfile.ZipFile(fixture) as old, zipfile.ZipFile(source, "w") as new:
                for item in old.infolist():
                    data = old.read(item)
                    if item.filename == "xl/workbook.xml":
                        data = data.replace("目标".encode(), "越南备货清单".encode())
                    if item.filename.startswith("xl/media/"):
                        data = picture.getvalue()
                    new.writestr(item, data)
            _, _, _, _, kept, compressed = sync.process_xlsx(source, output, "越南备货清单")
            self.assertTrue(kept)
            self.assertEqual(compressed, 2)
            with zipfile.ZipFile(source) as old, zipfile.ZipFile(output) as new:
                for path in ("xl/worksheets/sheet2.xml", "xl/cellimages.xml", "xl/_rels/cellimages.xml.rels"):
                    self.assertEqual(old.read(path), new.read(path))
                with Image.open(io.BytesIO(new.read("xl/media/image1.png"))) as image:
                    self.assertLessEqual(max(image.size), 48)

    def test_vietnam_invalid_image_preserves_destination(self):
        with tempfile.TemporaryDirectory() as folder:
            source = os.path.join(folder, "source.xlsx")
            output = os.path.join(folder, "output.xlsx")
            make_xlsx(source, remaining_dispimg=True)
            with zipfile.ZipFile(source, "a") as archive:
                archive.writestr("xl/workbook.xml", WORKBOOK.replace("目标", "越南备货清单"))
            with open(output, "wb") as existing:
                existing.write(b"original")
            with self.assertRaisesRegex(RuntimeError, "图片压缩失败"):
                sync.process_xlsx(source, output, "越南备货清单")
            with open(output, "rb") as existing:
                self.assertEqual(existing.read(), b"original")


if __name__ == "__main__":
    unittest.main()
