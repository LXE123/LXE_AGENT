# PDF 表单

PDF 表单里同一个值存两份：字段树里的值（`/V`），以及页面上每个控件的外观（`/AP`）。阅读器多数直接画外观；导出数据、再次编辑时读的是字段值。两份都要写对。

## 填写

1. 默认保留可编辑表单，只有用户明确要静态副本时才扁平化；保留原文件，另存新文件。带签名的 PDF 改写后签名会失效，XFA 表单 pypdf 只能改到 AcroForm 部分，这两种情况先问用户。
2. 填写前先看两边：`reader.get_fields()` 给出字段树里的字段；每页 `/Annots` 里 `/Subtype` 为 `/Widget` 的是控件，顺着 `/Parent` 拼出完整字段名。
3. 把用户给的信息对应到完整字段名。文本和下拉字段写字符串；勾选框写该控件 `/AP` `/N` 里除 `/Off` 以外的状态名（常见 `/Yes`、`/On`、`/1`），不选写 `/Off`；单选组写选中项的状态名。

下面的写法用 pypdf 填写全部页面。只接回真正游离的控件：页面上有、字段树里没有，并且不和已有字段重名。重名时接回会造出第二个同名字段，向用户说明，或在用户同意后只做静态副本。

```python
from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject


def full_name(node):
    parts = []
    while node is not None:
        if "/T" in node:
            parts.append(str(node["/T"]))
        parent = node.get("/Parent")
        node = parent.get_object() if parent is not None else None
    return ".".join(reversed(parts))


def field_tree_ids(root):
    acro_form = root.get("/AcroForm")
    pending = list(acro_form.get_object().get("/Fields", [])) if acro_form else []
    seen = set()
    while pending:
        reference = pending.pop()
        if reference.idnum not in seen:
            seen.add(reference.idnum)
            pending.extend(reference.get_object().get("/Kids", []))
    return seen


reader = PdfReader(input_pdf)
writer = PdfWriter()
writer.clone_document_from_reader(reader)

tree = field_tree_ids(writer.root_object)
known = set(writer.get_fields() or {})
orphans = [full_name(ref.get_object()) for page in writer.pages for ref in page.get("/Annots", [])
           if ref.get_object().get("/Subtype") == "/Widget" and ref.idnum not in tree]
duplicates = sorted(set(orphans) & known)
if duplicates:
    raise ValueError(f"Widgets share names with separate fields: {duplicates}")
if orphans:
    writer.reattach_fields()

fields = writer.get_fields() or {}
missing = set(expected_values) - set(fields)
if missing:
    raise ValueError(f"Form fields not found: {sorted(missing)}")

values_to_write = dict(expected_values)
if flatten:
    # 先把所有字段已有的值画上去，再删除控件。
    values_to_write = {
        name: field.get("/V", "/Off" if field.get("/FT") == "/Btn" else "")
        for name, field in fields.items()
    }
    values_to_write.update(expected_values)

writer.update_page_form_field_values(None, values_to_write, auto_regenerate=False, flatten=flatten)

if flatten:
    # flatten=True 只画外观，不删除控件和字段树。
    writer.remove_annotations(subtypes="/Widget")
    writer.root_object.pop(NameObject("/AcroForm"), None)

with open(output_pdf, "wb") as stream:
    writer.write(stream)
```

## 核对

交付前重新打开写出的文件：

- 可编辑版本：每个预期字段都在 `get_fields()` 里，`/V` 等于预期值；再遍历一遍页面控件，每个控件自身或继承自 `/Parent` 的值与预期一致，勾选框的 `/AS` 与值对应；每个填过的控件都有非空的 `/AP` `/N` 外观。
- 扁平化版本：页面上没有 `/Widget`，也没有 `/AcroForm`；文本值能在页面文字里找到。同时另存一份可编辑版本，方便用户以后修改。

然后渲染填写过的页面并查看，检查文字是否超框、截断或压住其他内容。渲染图只证明版式，不证明数据：外观缺失时，内置引擎会按字段值把内容补画出来，图上照样显示正常，其他阅读器却可能是空白。也不要把 `/NeedAppearances` 当作已经写好外观的证据。

## 中文和表单字体

表单自带的字体常常只有西文字符。pypdf 用它生成中文外观时，会在 `pypdf` logger 里提示 `contains characters not supported by font encoding`，外观里的汉字变成 `?`，渲染出来就是问号。逐个字段写入并收集这条日志，就能知道是哪几个字段。

- 可编辑版本：删掉这些控件的 `/AP`，调用 `writer.set_need_appearances_writer(True)`，让阅读器按字段值重画。内置引擎实测能正确显示中文；Acrobat、Chrome、Edge 通常也会重画，其他阅读器可能显示空白，交付时告诉用户。这些控件不适用上面“非空外观”的核对。
- 静态副本：没有可靠做法，先问用户。用户同意的话，可以把渲染图拼成图片型 PDF，但文字无法再选中或搜索。
