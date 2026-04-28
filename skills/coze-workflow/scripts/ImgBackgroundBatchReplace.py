import argparse
import csv
import json
import os
import sys
import tempfile
import time
import zipfile
from datetime import datetime
from pathlib import Path

import py7zr
from cozepy import COZE_CN_BASE_URL, Coze, CozeAPIError, TokenAuth

# ==========================================
# 1. 全局配置与客户端初始化
# ==========================================
API_TOKEN="pat_2X00nRaXOAaFsYGnuR1eHYydOrkPbtDjlqi2A7MVs5HwTcncloMzmDkGVsTS1eUM"
workflow_id="workflow_id=7627044433981292579"
BATCH_SIZE = 10

coze_client = Coze(auth=TokenAuth(token=API_TOKEN), base_url=COZE_CN_BASE_URL)


def configure_stdio():
    """避免 Windows 控制台编码导致输出中断。"""
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def print_progress(stage: str, **kwargs):
    items = [f"stage={stage}"]
    for key, value in kwargs.items():
        items.append(f"{key}={value}")
    print("PROGRESS " + " ".join(items), flush=True)


def print_result_file_outputs(file_path: str):
    print(f"RESULT_FILE_PATH={file_path}")
    print("RESULT_FILE_ACTION=send_to_user")
    print("RESULT_NOTICE=请把该结果文件路径中的文件发送给用户。")


def extract_archive(file_path: str, extract_to_dir: str):
    """支持 zip 和 7z 格式解压。"""
    ext = os.path.splitext(file_path)[-1].lower()
    if ext == ".zip":
        with zipfile.ZipFile(file_path, "r") as ref:
            ref.extractall(extract_to_dir)
    elif ext == ".7z":
        with py7zr.SevenZipFile(file_path, mode="r") as ref:
            ref.extractall(path=extract_to_dir)
    else:
        raise ValueError(f"不支持的压缩包格式: {ext}")


def get_repo_root() -> Path:
    """根据当前脚本位置定位仓库根目录。"""
    return Path(__file__).resolve().parents[3]


def parse_args():
    parser = argparse.ArgumentParser(description="批量替换图片背景并导出结果 CSV。")
    # 兼容两种调用方式：
    # 1) 位置参数：script.py <archive_file_path> <prompt_text>
    # 2) 命名参数：script.py --archive-file-path xxx --prompt-text yyy
    parser.add_argument("archive_file_path", nargs="?", help="待处理压缩包路径（支持 .zip/.7z）")
    parser.add_argument("prompt_text", nargs="?", help="背景替换提示词文本")
    parser.add_argument("--archive-file-path", dest="archive_file_path_opt", help="待处理压缩包路径（支持 .zip/.7z）")
    parser.add_argument("--prompt-text", dest="prompt_text_opt", help="背景替换提示词文本")

    args = parser.parse_args()
    archive_file_path = args.archive_file_path_opt or args.archive_file_path
    prompt_text = args.prompt_text_opt or args.prompt_text

    if not archive_file_path or not prompt_text:
        parser.error("必须提供 archive_file_path 和 prompt_text（可用位置参数或 --archive-file-path/--prompt-text）。")
    return archive_file_path, prompt_text


def main(archive_file_path: str, prompt_text: str):
    start_ts = time.time()
    all_debug_urls = []

    if not os.path.exists(archive_file_path):
        print(f"ERROR 找不到压缩包: {archive_file_path}")
        return all_debug_urls

    output_dir = get_repo_root() / "artifacts" / "imgreplace"
    output_dir.mkdir(parents=True, exist_ok=True)
    csv_filename = f"batch_result_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
    csv_abs_path = (output_dir / csv_filename).resolve()
    csv_rel_path = csv_abs_path.relative_to(get_repo_root()).as_posix()

    try:
        with open(csv_abs_path, mode="w", encoding="utf-8-sig", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(["Original_Filename", "Replaced_Image_URL"])
        print(f"INFO CSV 结果文件已就绪: {csv_abs_path}")
        print_result_file_outputs(csv_rel_path)
        print_progress(stage="save_csv_ready", total_images=0, uploaded_ok=0, elapsed_s=int(time.time() - start_ts))
    except Exception as e:
        print(f"ERROR 无法创建 CSV 文件(请检查权限): {e}")
        return all_debug_urls

    with tempfile.TemporaryDirectory() as temp_dir:
        print("INFO 正在解压文件...")
        print_progress(stage="extract_start", elapsed_s=int(time.time() - start_ts))
        try:
            extract_archive(archive_file_path, temp_dir)
        except Exception as e:
            print(f"ERROR 解压失败: {e}")
            return all_debug_urls

        image_paths = []
        for root, _, files in os.walk(temp_dir):
            for file in files:
                if "__MACOSX" in root or file.startswith("."):
                    continue
                if file.lower().endswith((".png", ".jpg", ".jpeg")):
                    image_paths.append(os.path.join(root, file))

        total_images = len(image_paths)
        if total_images == 0:
            print("WARN 未在压缩包中找到有效图片。")
            return all_debug_urls

        total_batches = (total_images + BATCH_SIZE - 1) // BATCH_SIZE
        uploaded_ok_total = 0
        print(f"INFO 共发现 {total_images} 张图片，开始分批处理...")
        print_progress(
            stage="extract_done",
            total_images=total_images,
            batch_size=BATCH_SIZE,
            batches=total_batches,
            elapsed_s=int(time.time() - start_ts),
        )

        for i in range(0, total_images, BATCH_SIZE):
            batch_paths = image_paths[i : i + BATCH_SIZE]
            batch_num = (i // BATCH_SIZE) + 1
            print(f"INFO 正在处理第 {batch_num} 批 (共 {len(batch_paths)} 张)")
            print_progress(
                stage="upload",
                batch=batch_num,
                batches=total_batches,
                uploaded_ok=uploaded_ok_total,
                total_images=total_images,
                elapsed_s=int(time.time() - start_ts),
            )

            batch_records = []
            batch_file_ids = []

            for path in batch_paths:
                file_name = os.path.basename(path)
                try:
                    with open(path, "rb") as image_file:
                        uploaded_file = coze_client.files.upload(file=image_file)
                        batch_file_ids.append(uploaded_file.id)
                        batch_records.append(file_name)
                        uploaded_ok_total += 1
                except Exception as e:
                    print(f"WARN 上传失败 {file_name}: {e}")

            if not batch_file_ids:
                print("WARN 本批次全部上传失败，跳过。")
                continue

            payload = json.dumps([{"file_id": fid} for fid in batch_file_ids])
            inputs = {"input_text": prompt_text, "input_file": payload}

            workflow_success = False
            result = None
            try:
                print_progress(
                    stage="workflow_start",
                    batch=batch_num,
                    batches=total_batches,
                    uploaded_ok=uploaded_ok_total,
                    total_images=total_images,
                    elapsed_s=int(time.time() - start_ts),
                )
                print("INFO 运行工作流...")
                result = coze_client.workflows.runs.create(workflow_id=WORKFLOW_ID, parameters=inputs)
                workflow_success = True

                current_debug_url = getattr(result, "debug_url", "无Debug链接")
                if current_debug_url and current_debug_url != "无Debug链接":
                    all_debug_urls.append(current_debug_url)
                    print(f"INFO 追踪链接 {current_debug_url}")

                print_progress(
                    stage="workflow_done",
                    batch=batch_num,
                    batches=total_batches,
                    uploaded_ok=uploaded_ok_total,
                    total_images=total_images,
                    elapsed_s=int(time.time() - start_ts),
                )
            except CozeAPIError as e:
                if e.code == 4028 or "insufficient" in str(e).lower():
                    print("ERROR Coze 账号算力额度耗尽，程序强制终止。")
                    return all_debug_urls
                print(f"ERROR API 错误: {e.msg}")
            except Exception as e:
                print(f"ERROR 未知异常: {e}")

            if workflow_success and result and result.data:
                try:
                    parsed = json.loads(result.data)
                    output_array = parsed.get("output", [])
                    if isinstance(output_array, str):
                        output_array = json.loads(output_array) if output_array else []

                    print_progress(
                        stage="write_csv",
                        batch=batch_num,
                        batches=total_batches,
                        uploaded_ok=uploaded_ok_total,
                        total_images=total_images,
                        elapsed_s=int(time.time() - start_ts),
                    )
                    try:
                        with open(csv_abs_path, mode="a", encoding="utf-8-sig", newline="") as f:
                            writer = csv.writer(f)
                            for idx, orig_name in enumerate(batch_records):
                                new_url = str(output_array[idx]) if idx < len(output_array) else "未获取到URL"
                                writer.writerow([orig_name, new_url])
                        print(f"INFO 第 {batch_num} 批次结果已写入 CSV。")
                    except PermissionError:
                        print("WARN CSV 被其它程序锁定，本批次写入失败。请勿在运行时打开此文件。")
                except Exception as e:
                    print(f"ERROR 解析失败: 数据处理异常: {e}")

            if i + BATCH_SIZE < total_images:
                time.sleep(5)

    print_progress(
        stage="save_csv_done",
        uploaded_ok=uploaded_ok_total,
        total_images=total_images,
        elapsed_s=int(time.time() - start_ts),
    )
    print(f"INFO 任务全部结束。结果已保存至: {csv_abs_path}")
    print_result_file_outputs(csv_rel_path)

    return all_debug_urls


if __name__ == "__main__":
    configure_stdio()
    archive_file_path, prompt_text = parse_args()
    debug_links = main(archive_file_path, prompt_text)
    if debug_links:
        print("INFO 运行日志汇总")
        for index, link in enumerate(debug_links, 1):
            print(f"第 {index} 批次: {link}")
