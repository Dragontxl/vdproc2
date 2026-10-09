#!/usr/bin/env python3
"""Agnes Video 2.0 接入测试脚本（仅标准库，无第三方依赖）。

用法示例：
  # 文生视频
  python3 test_agnes_video.py --api-key $AGNES_API_KEY \
      --mode text --prompt "一只橘猫在窗台上晒太阳，镜头缓慢推近" --num-frames 41 --frame-rate 8 --output cat.mp4

  # 首尾帧控制（本项目主要场景）
  python3 test_agnes_video.py --api-key $AGNES_API_KEY \
      --mode keyframes \
      --images "https://example.com/first.png,https://example.com/last.png" \
      --prompt "人物自然转身走向窗边，固定机位，画面平滑过渡" \
      --num-frames 41 --frame-rate 8 --output demo.mp4

参数说明（对齐 agnes-video-v2.0）：
  num_frames   最小 9，按 8n+1 对齐（9, 17, 25, 33, 41...），默认 41
  frame_rate   帧率，默认 8
  width/height 默认 832x448（16:9）
  轮询         推荐 5-10 秒/次，仅用 video_id（不带 model_name）
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

MODEL_DEFAULT = "agnes-video-v2.0"
POLL_ENDPOINT = "/agnesapi"


def http_request(method, url, headers=None, body=None, timeout=60):
    """返回 (http_code, response_bytes)。网络异常时返回 (0, 错误信息)。"""
    req = urllib.request.Request(url, method=method, headers=headers or {}, data=body)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:
        return 0, str(e).encode("utf-8", errors="replace")


def calc_num_frames(target_frames):
    if target_frames < 9:
        return 9
    n = (target_frames - 1) // 8
    num_frames = n * 8 + 1
    return max(num_frames, 9)


def build_payload(args):
    payload = {
        "model": args.model,
        "prompt": args.prompt,
        "mode": args.mode,
        "num_frames": args.num_frames,
        "frame_rate": args.frame_rate,
        "width": args.width,
        "height": args.height,
    }

    if args.mode == "keyframes":
        if args.images:
            payload["extra_body"] = {
                "image": args.images,
                "mode": "keyframes",
            }
        else:
            sys.exit("keyframes 模式需要 --images")
    elif args.mode == "text":
        pass
    return payload


def create_task(args):
    url = args.base_url.rstrip("/") + "/videos"
    headers = {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + args.api_key,
    }
    body = json.dumps(build_payload(args), ensure_ascii=False).encode("utf-8")
    print(f"[create] POST {url}")
    status, data = http_request("POST", url, headers, body, timeout=args.timeout)
    if status == 0:
        sys.exit(f"[create] 网络错误: {data.decode('utf-8', errors='replace')}")
    if status != 200:
        msg = data.decode("utf-8", errors="replace")[:500]
        sys.exit(f"[create] HTTP {status}: {msg}")
    resp = json.loads(data)
    video_id = resp.get("video_id") or resp.get("id") or resp.get("task_id")
    if not video_id:
        sys.exit(f"[create] 响应中没有 video_id: {json.dumps(resp, ensure_ascii=False)}")
    print(f"[create] 成功. video_id={video_id}, model={resp.get('model')}")
    return video_id


def poll_task(args, video_id):
    parsed = urllib.parse.urlparse(args.base_url)
    base_poll = f"{parsed.scheme}://{parsed.netloc}{POLL_ENDPOINT}"
    headers = {"Authorization": "Bearer " + args.api_key}
    max_polls = args.max_polls
    for i in range(1, max_polls + 1):
        qs = urllib.parse.urlencode({"video_id": video_id})
        url = f"{base_poll}?{qs}"
        status, data = http_request("GET", url, headers, timeout=args.timeout)
        if status == 0:
            print(f"[poll {i}/{max_polls}] 网络错误: {data.decode('utf-8', errors='replace')}")
        elif status != 200:
            msg = data.decode("utf-8", errors="replace")[:500]
            print(f"[poll {i}/{max_polls}] HTTP {status}: {msg}")
        else:
            resp = json.loads(data)
            st = resp.get("status", "")
            progress = resp.get("progress", 0)
            print(f"[poll {i}/{max_polls}] status={st} progress={progress}%")
            if st == "completed":
                url = resp.get("url")
                if not url:
                    sys.exit("[poll] completed 但没有 url 字段")
                return url
            if st == "failed":
                err = resp.get("error") if isinstance(resp.get("error"), dict) else {"message": resp.get("error")}
                sys.exit(f"[poll] 任务失败: {err}")
        if i < max_polls:
            time.sleep(args.poll_interval)
    sys.exit(f"[poll] 超过 {max_polls} 次轮询未完成，请检查任务状态")


def download(url, output, timeout=120):
    print(f"[download] {url}")
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp, open(output, "wb") as f:
            total = 0
            while True:
                chunk = resp.read(1024 * 512)
                if not chunk:
                    break
                f.write(chunk)
                total += len(chunk)
        print(f"[download] 完成，写入 {output}（{total} 字节）")
    except Exception as e:
        sys.exit(f"[download] 失败: {e}")


def main():
    parser = argparse.ArgumentParser(description="Agnes Video 2.0 测试脚本")
    parser.add_argument("--api-key", default=os.environ.get("AGNES_API_KEY", "").strip() or None, help="API Key（或环境变量 AGNES_API_KEY）")
    parser.add_argument("--base-url", default="https://apihub.agnes-ai.com/v1", help="API Base URL")
    parser.add_argument("--model", default=MODEL_DEFAULT)
    parser.add_argument("--mode", choices=["text", "keyframes"], default="text")
    parser.add_argument("--prompt", default="一只橘猫坐在窗台上晒太阳，镜头缓慢平稳推近，电影质感", help="视频内容描述")
    parser.add_argument("--num-frames", type=int, default=41, help="帧数，最小9，按8n+1对齐")
    parser.add_argument("--frame-rate", type=int, default=8, help="帧率，默认8")
    parser.add_argument("--width", type=int, default=832, help="视频宽度")
    parser.add_argument("--height", type=int, default=448, help="视频高度")
    parser.add_argument("--images", default=None, help="keyframes 模式图片 URL，多个用逗号分隔")
    parser.add_argument("--output", default="test_output.mp4")
    parser.add_argument("--poll-interval", type=float, default=5.0, help="轮询间隔（秒），推荐5-10")
    parser.add_argument("--max-polls", type=int, default=600)
    parser.add_argument("--timeout", type=int, default=60, help="HTTP 请求超时（秒）")
    parser.add_argument("--download-timeout", type=int, default=120, help="下载超时（秒）")
    args = parser.parse_args()

    if not args.api_key:
        sys.exit("缺少 --api-key 或环境变量 AGNES_API_KEY")
    if args.images:
        args.images = [u.strip() for u in args.images.split(",") if u.strip()]

    args.num_frames = calc_num_frames(args.num_frames)
    print(f"[config] model={args.model}, mode={args.mode}, num_frames={args.num_frames}, frame_rate={args.frame_rate}, size={args.width}x{args.height}")

    t0 = time.time()
    video_id = create_task(args)
    result_url = poll_task(args, video_id)
    download(result_url, args.output, timeout=args.download_timeout)
    print(f"[done] 总耗时 {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
