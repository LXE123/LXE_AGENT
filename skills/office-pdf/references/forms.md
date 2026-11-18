# PDF 表单

PDF 表单里同一个值存两份：字段树里的值（`/V`），以及页面上控件的外观（`/AP`）。阅读器多数直接画外观，所以只改值、外观没更新，用户看到的还是旧内容；反过来，外观对了、字段值没写进去，导出数据或再次编辑时又会出错。`scripts/pdf_form.py` 把两份都写好并逐项核对。

脚本位于本技能目录，用 `uv run --frozen python "<技能目录>/scripts/pdf_form.py" <命令>` 调用。每个命令输出一个 JSON；`fill` 和 `verify` 发现结果不可信时以退出码 1 结束，输出里带原始原因。

## 1. 查看字段

```sh
uv run --frozen python "<技能目录>/scripts/pdf_form.py" inspect "原表.pdf"
```

关注这几项：

- `fields`：完整字段名、类型（`/Tx` 文本、`/Btn` 勾选框或单选、`/Ch` 下拉、`/Sig` 签名）、当前值和可选项。
- `widgets`：每个控件所在页、位置和当前外观状态。勾选框的 `on_states` 就是“选中”时要写的值。
- `orphaned_widgets`：页面上有控件但字段树里没有。`fill` 会自动接回字段树。
- `ambiguous_widgets`：控件和字段树里另一个字段重名，接回会造出两个同名字段。`fill` 会拒绝，向用户说明，或在用户同意后只做静态副本。
- `signed`、`xfa`：带签名或 XFA 的表单，`fill` 会拒绝，先问用户怎么处理。

把用户给的信息对应到字段名，写成 UTF-8 的 JSON 文件。字段名用 `inspect` 输出的完整名称，不要猜：

```json
{"shipper": "深圳某某贸易有限公司", "invoice_no": "INV-2026-001", "agree": true, "transport": "/Sea"}
```

文本和下拉字段写字符串；勾选框写 `true`/`false`，有多个选中状态时直接写状态名；单选组写选中项的状态名。

## 2. 填写

```sh
uv run --frozen python "<技能目录>/scripts/pdf_form.py" fill "原表.pdf" "已填写.pdf" --values "values.json"
```

输出文件必须是新路径。用户明确要静态副本时加 `--flatten`：先把所有字段当前的值画到页面上，再删掉控件和字段树。同时另存一份可编辑版本，方便用户以后修改。

## 3. 核对

```sh
uv run --frozen python "<技能目录>/scripts/pdf_form.py" verify "已填写.pdf" --values "values.json"
```

可编辑版本逐个检查：字段值、每个控件继承到的值、勾选框的显示状态，以及外观是否存在。扁平化版本加 `--flattened`，检查控件和字段树已经清除、文本值出现在页面文字里。`ok` 为 `false` 时按 `problems` 修正后重做，不要交付。

最后渲染填写过的页面并查看，检查文字是否超出框、被截断或压住其他内容。渲染图只证明版式，不证明数据：引擎会按字段值重画外观，文件里的外观缺失时，图上照样显示正常。

## 中文和表单字体

表单自带的字体常常只有西文字符。pypdf 用它生成中文外观时会把汉字写成 `?`，`fill` 的输出里能看到 pypdf 的原始提示。

- **可编辑版本**：`fill` 会删掉这些字段的错误外观，并要求阅读器按字段值自己重画；这些字段列在 `reader_generated_appearance` 里。内置引擎（PDFium）实测能正常显示中文；Acrobat 和 Chrome、Edge 通常也会重画，其他阅读器可能显示空白。交付时把这一点告诉用户。
- **静态副本**：没有可靠做法，`fill --flatten` 会拒绝。PDFium 扁平化用的是本机系统字体，字体不会嵌入文件，换台电脑可能就显示不出来。用户坚持要静态版时，可以在用户同意后把渲染图拼成图片型 PDF，但文字无法再选中或搜索。
