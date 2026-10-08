"""验证 fatcat-bot 生成的 PDF 与子集字体。

1) FreeType(PIL) 加载子集字体 -> 表结构必须合法
2) 子集字体真实渲染 -> 与原始字体逐像素比对（只比对确实进了子集的码点）
3) 解析 PDF：xref 偏移、对象、流长度、zlib 解压、内嵌字体可再解析、内容流 CID 合法
"""
import json
import re
import sys
import zlib
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

BASE = Path(r"C:\Users\Administrator\WorkBuddy AI\2026-10-08-21-09-47\fatcat-bot\data\pdftest")
meta = json.loads((BASE / "meta.json").read_text(encoding="utf-8"))
charset = set(meta["charset"])
fails = []


def check(ok, msg):
    print(("  PASS  " if ok else "  FAIL  ") + msg)
    if not ok:
        fails.append(msg)


print("=" * 70)
print("[1] FreeType 校验子集字体")
print("=" * 70)
subset_path = BASE / "subset.ttf"
try:
    sub = ImageFont.truetype(str(subset_path), 48)
    check(True, f"FreeType 成功加载子集字体（{subset_path.stat().st_size/1024:.1f} KB）")
except Exception as e:
    check(False, f"FreeType 加载失败: {e}")
    sys.exit(1)

print()
print("=" * 70)
print("[2] 子集字体渲染 vs 原始字体（逐像素）")
print("=" * 70)
orig = ImageFont.truetype(meta["fontPath"], 48)


def ink(font, text, size=(900, 80)):
    im = Image.new("L", size, 0)
    ImageDraw.Draw(im).text((8, 8), text, font=font, fill=255)
    return im


# 用文档里真实出现的文本做对比（保证所有字符都在子集内）
doc_text = meta["sampleText"]
check(len(doc_text) > 100, f"对比样本长度 {len(doc_text)}")

a = ink(orig, doc_text, (900, 60))
b = ink(sub, doc_text, (900, 60))
diff = sum(1 for x, y in zip(a.getdata(), b.getdata()) if x != y)
check(diff == 0, f"整段文档逐像素完全一致（差异像素 {diff}）")

# 全字符集逐个对比
bad = []
for cp in meta["charset"]:
    ch = chr(cp)
    if ch in "\n\r\t":
        continue
    ia = ink(orig, ch, (80, 80))
    ib = ink(sub, ch, (80, 80))
    if ia.tobytes() != ib.tobytes():
        bad.append(ch)
check(not bad, f"子集内 {len(meta['charset'])} 个码点逐个渲染一致" + (f"（不一致 {len(bad)} 个: {''.join(bad[:12])}）" if bad else ""))

# 覆盖测试：子集必须包含文档中每一个可显示字符
missing = sorted({ch for ch in doc_text if ord(ch) > 32 and ord(ch) not in charset})
check(not missing, "文档字符全部进入子集" + (f"（遗漏: {''.join(missing[:20])}）" if missing else ""))

# 渲染一张对照图供人工查看（标签用原字体绘制，避免标签字符不在子集内）
lines = ["口嗨片段 #42", "朔子与希斯·回旋镖", "肥肥风筝猫的记录", "ABC 123 中文混排", "据数据导出口嗨猫测试"]
im = Image.new("L", (760, 110 * (len(lines) * 2 + 1)), 255)
d = ImageDraw.Draw(im)
big_o = ImageFont.truetype(meta["fontPath"], 64)
big_s = ImageFont.truetype(str(subset_path), 64)
label = ImageFont.truetype(meta["fontPath"], 20)
y = 10
for s in lines:
    d.text((10, y), "ORIG", font=label, fill=0)
    d.text((80, y), s, font=big_o, fill=0)
    y += 110
    d.text((10, y), "SUBSET", font=label, fill=0)
    d.text((80, y), s, font=big_s, fill=0)
    y += 110
im.save(BASE / "compare.png")
print(f"  对照图已保存: {BASE / 'compare.png'}")

print()
print("=" * 70)
print("[3] PDF 结构校验")
print("=" * 70)


def validate_pdf(pdf_path: Path):
    name = pdf_path.name
    data = pdf_path.read_bytes()
    print(f"\n--- {name} ({len(data)/1024:.1f} KB) ---")
    check(data.startswith(b"%PDF-1.7"), "文件头 %PDF-1.7")
    check(data.rstrip().endswith(b"%%EOF"), "文件尾 %%EOF")

    m = re.search(rb"startxref\s+(\d+)\s+%%EOF\s*$", data)
    if not m:
        check(False, "找到 startxref")
        return
    xref_off = int(m.group(1))
    check(data[xref_off:xref_off + 4] == b"xref", f"startxref 指向 xref 表（偏移 {xref_off}）")

    hm = re.match(rb"xref\s+(\d+)\s+(\d+)\s+", data[xref_off:xref_off + 60])
    if not hm:
        check(False, "解析 xref 头")
        return
    start, count = int(hm.group(1)), int(hm.group(2))
    check(start == 0, f"xref 从 0 开始（start={start}）")
    body_off = xref_off + hm.end()
    entries = [data[body_off + i * 20: body_off + (i + 1) * 20] for i in range(count)]
    check(all(len(e) == 20 for e in entries), f"xref 共 {count} 条，每条 20 字节")
    check(entries[0] == b"0000000000 65535 f \n", "条目 0 为 free 且格式正确")

    bad, offsets = [], {}
    for i in range(1, count):
        off = int(entries[i][:10])
        offsets[i] = off
        expect = f"{i} 0 obj".encode()
        if data[off:off + len(expect)] != expect:
            bad.append((i, off))
    check(not bad, f"全部 {count-1} 个对象偏移正确" + (f" 异常: {bad[:3]}" if bad else ""))

    tr = data.rfind(b"trailer")
    trailer = data[tr:tr + 200]
    check(b"/Root 1 0 R" in trailer and b"/Info 8 0 R" in trailer, "trailer 含 /Root 与 /Info")
    tm = re.search(rb"/Size (\d+)", trailer)
    check(tm and int(tm.group(1)) == count, "trailer /Size 与 xref 一致")

    n_streams, n_pages, font_file2, cid_max = 0, 0, None, 0
    for i in range(1, count):
        off = offsets[i]
        chunk = data[off:data.find(b"endobj", off)]
        if re.search(rb"/Type\s*/Page(?![s])", chunk):
            n_pages += 1
            check(b"/MediaBox" in chunk and b"/Contents" in chunk, f"对象 {i} 是合法 Page")
        sm = re.search(rb"<< (.*?) >>\nstream\n", chunk, re.S)
        if not sm:
            continue
        n_streams += 1
        header, sdata = sm.group(1), chunk[sm.end(): chunk.rfind(b"\nendstream")]
        lm = re.search(rb"/Length (\d+)", header)
        if not lm or int(lm.group(1)) != len(sdata):
            check(False, f"对象 {i} /Length 与实际长度一致")
            continue
        if b"/FlateDecode" in header:
            try:
                raw = zlib.decompress(sdata)
            except Exception as ex:
                check(False, f"对象 {i} zlib 解压: {ex}")
                continue
        else:
            raw = sdata
        if b"/Length1" in header:
            check(int(re.search(rb"/Length1 (\d+)", header).group(1)) == len(raw), f"对象 {i} /Length1 一致")
            font_file2 = raw
        if b"BT" in raw and b"Tj" in raw:
            for h in re.findall(rb"<([0-9A-F]+)> Tj", raw):
                for k in range(0, len(h), 4):
                    cid_max = max(cid_max, int(h[k:k + 4], 16))
    check(n_pages >= 1, f"页面对象数 {n_pages}")
    check(n_streams >= 3, f"流对象数量合理（{n_streams}）")

    # /Pages 的 /Kids 必须是合法引用（形如 "10 0 R"），且指向 Page 对象
    pages_obj = None
    for i in range(1, count):
        off = offsets[i]
        chunk = data[off:data.find(b"endobj", off)]
        if re.search(rb"/Type\s*/Pages(?![a-zA-Z])", chunk):
            pages_obj = chunk
            break
    if pages_obj is None:
        check(False, "找到 /Pages 对象")
    else:
        km = re.search(rb"/Kids\s*\[(.*?)\]", pages_obj, re.S)
        if not km:
            check(False, "/Pages 含 /Kids 数组")
        else:
            refs = km.group(1).split()
            ok = len(refs) % 3 == 0 and all(
                refs[k].isdigit() and refs[k + 1] == b"0" and refs[k + 2] == b"R" for k in range(0, len(refs), 3)
            )
            check(ok, f"/Kids 全为合法引用（{' '.join(r.decode() for r in refs[:6])}）")
            ck = re.search(rb"/Count\s+(\d+)", pages_obj)
            check(ck and int(ck.group(1)) == n_pages, f"/Count({ck.group(1) if ck else '?'}) 与实际页数({n_pages})一致")

    if font_file2:
        check(font_file2[:4] in (b"\x00\x01\x00\x00", b"true"), "FontFile2 是合法 SFNT 头")
        p = BASE / (name.replace(".pdf", "") + "-embedded.ttf")
        p.write_bytes(font_file2)
        try:
            ef = ImageFont.truetype(str(p), 48)
            ia = ink(orig, doc_text, (900, 60))
            ib = ink(ef, doc_text, (900, 60))
            d2 = sum(1 for x, y in zip(ia.getdata(), ib.getdata()) if x != y)
            check(d2 == 0, f"PDF 内嵌字体渲染与原文逐像素一致（差异 {d2}）")
        except Exception as ex:
            check(False, f"PDF 内嵌字体加载失败: {ex}")
    else:
        check(False, "找到 FontFile2 流")

    check(cid_max < meta["numGlyphs"], f"内容流 CID 最大值 {cid_max} < 字形数 {meta['numGlyphs']}")
    return n_pages


for p in sorted(BASE.glob("sample*.pdf")):
    validate_pdf(p)

print()
print("=" * 70)
if fails:
    print(f"结果：{len(fails)} 项失败")
    for x in fails:
        print("  - " + x)
    sys.exit(1)
print("结果：全部通过")
