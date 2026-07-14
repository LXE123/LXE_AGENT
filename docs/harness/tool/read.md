### read 工具支持两类文件
1. 文本文件（所有非图片文件）
任何文件只要不被识别为图片，就按 UTF-8 文本读取。没有后缀白名单，什么 .py、.js、.json、.md、.csv、.xml、.yaml、.log、.txt ... 全部当文本读。

截断限制：

默认最多 DEFAULT_MAX_LINES 行
或 DEFAULT_MAX_BYTES（50KB）
DEFAULT_MAX_LINES = 2000，DEFAULT_MAX_BYTES = 50KB，哪个先到用哪个。
哪个先到用哪个
超了会提示 Use offset=N to continue

2. 图片文件（仅 4 种格式）
// mime.js:3
const IMAGE_MIME_TYPES = new Set([
    "image/jpeg",   // .jpg .jpeg
    "image/png",    // .png
    "image/gif",    // .gif
    "image/webp"    // .webp
]);

#### 看文件头，不看后缀名
一个 .txt 后缀的文件如果内容实际是 PNG，会被当图片处理。反过来一个 .png 后缀但内容是文本，会被当文本读。

// 读文件头 4100 字节，用 file-type 库做 magic number 检测
const FILE_TYPE_SNIFF_BYTES = 4100;
const fileType = await fileTypeFromBuffer(buffer.subarray(0, bytesRead));

#### 提示词：
Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.

就这一段 description，加上参数 schema：

{
    path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
    offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
}

#### 图片会自动 resize

const autoResizeImages = options?.autoResizeImages ?? true;
// 默认开启，读取图片时自动缩放
const resized = await resizeImage({ type: "image", data: base64, mimeType });

#### 图片自动缩放多级策略

目标参数：

- `maxWidth: 2000`
- `maxHeight: 2000`
- `maxBytes: 4.5MB`
- `jpegQuality: 80`

按顺序尝试，成功就停：

1. 原图满足 `宽 <= 2000`、`高 <= 2000`、`大小 <= 4.5MB`，直接返回原图。
2. 缩放到 `2000x2000` 以内（保持比例），同时尝试 PNG 和 JPEG，JPEG 默认质量 `80`，选更小且 `<= 4.5MB` 的结果。
3. 同一尺寸下继续尝试 JPEG 质量：`85 -> 70 -> 55 -> 40`。
4. 再按尺寸倍率 `0.75 / 0.5 / 0.35 / 0.25` 逐级缩小；每一级都尝试 JPEG 质量 `85 / 70 / 55 / 40`。
5. 如果全部仍然超限，返回所有尝试里二进制最小的那个结果。

所有缩放都保持比例，不放大。GIF/WebP 只读取首帧，按静态图片处理。

#### 坐标映射提示

返回给模型的文本说明里会包含：

`[Image: original 4000x3000, displayed at 2000x1500. Multiply coordinates by 2.00 to map to original image.]`

这样模型如果需要定位图片元素，知道要把缩放后坐标按倍率映射回原图。

#### 返回格式
文本返回 [{ type: "text", text: "文件内容" }]，
图片返回 [{ type: "text", text: "Read image file [image/png]\n[Image: original 4000x3000, displayed at 2000x1500. Multiply coordinates by 2.00 to map to original image.]" }, { type: "image", data: base64, mimeType }]，是两个 content block。

其余都对。
