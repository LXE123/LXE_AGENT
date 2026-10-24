# 送达时段弹窗样本

`delivery_window_modal.sanitized.html` 来自此前本地留存的真实弹窗片段
`delivery_window_modal.html`，经本次检查后作为可入库样本保存。片段仅包含
公开界面文案、控件结构、示例日期和公共帮助链接，没有货件号、账号、公司、
Cookie 或 token；未补造页面节点，也不是重新抓取的当前生产页面。

六项 HTML 读取测试直接使用此文件，缺文件应失败，不再跳过。它不包含日历
Shadow DOM，不能用来证明日历点击、真实提交或当前站点兼容性已通过。
原始本地文件仍受 `.gitignore` 保护。
