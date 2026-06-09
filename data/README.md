# 本机业务数据目录

这个目录用于放置 FBA 相关 skill 会用到的业务模板和基础数据。真实 Excel 文件由业务
人员维护，可能随时替换，因此不会提交到 Git。

使用相关功能前，需要准备以下文件：

- `data/customs_declaration/custom_declaration_documents.xlsx`
- `data/export_tax/export_tax_products.xlsx`
- `data/invoice_Template/invoice_Template.xlsx`

使用规则：

- 新机器部署时，如需使用相关 FBA 功能，从内部业务数据包复制这些文件。
- 业务人员可以替换同名文件，只要路径和文件名保持不变。
- 不要提交这个目录里的真实 Excel 文件。
- `~$*.xlsx` 这类 Office 临时锁文件会被忽略。
