#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
fetch_video.py — 为 piki「阵容采集」抓取在线视频的文字信息。

用途：从一个在线视频链接（YouTube/B站等）取出
  - 元数据：标题 / 上传者 / 时长 / 链接
  - 视频简介（description，常含 rental 租借队码或队伍列表）
  - 字幕（优先人工字幕，回退自动字幕；解说里藏着玩法技巧/注意事项/对策）
全部汇总成一个 Markdown 文件，供模型读取。

刻意只依赖 yt-dlp（缺失会自动 pip 安装），**不依赖 ffmpeg**：
字幕以原生 vtt 下载后在本脚本内转纯文本，无需转码。
需要画面才能辨认阵容时，由 piki 改请用户补一张队伍截图（见 references/video-ingest.md）。

用法：
    python fetch_video.py <video_url> <output_dir>

约定（供 piki 解析 stdout）：脚本最后会打印若干 `key: value` 行，
其中 `output_file:` 是汇总文件路径，`subtitles:` 是字幕状态（none 表示没抓到，
此时阵容大概率需要用户补截图）。
"""
import sys
import os
import re
import glob
import site
import importlib
import subprocess

# Windows 控制台默认 GBK，中文输出会乱码甚至 UnicodeEncodeError；统一切到 utf-8。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001  老解释器或非标准流，忽略
        pass


def ensure_ytdlp():
    """确保 yt-dlp 可导入，缺失则自动安装（计划已确认：自动装）。"""
    try:
        import yt_dlp  # noqa: F401
        return
    except ImportError:
        print("[fetch_video] yt-dlp 未安装，正在 pip install yt-dlp ...", flush=True)
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "-q", "--upgrade", "yt-dlp"],
            check=True,
        )
        # pip 常做 --user 安装；让当前进程能立刻 import 到刚装好的包：
        # 把 user site 加进 sys.path 并清掉导入查找缓存。
        user_site = site.getusersitepackages()
        if user_site and user_site not in sys.path:
            site.addsitedir(user_site)
        importlib.invalidate_caches()


def pick_sub_lang(info, kind):
    """从 subtitles / automatic_captions 中挑一个语言，优先中→日→英。"""
    subs = info.get(kind) or {}
    if not subs:
        return None
    langs = list(subs.keys())

    def score(lang):
        low = lang.lower()
        for i, pref in enumerate(("zh", "ja", "en")):
            if low.startswith(pref):
                return i
        return 10

    langs.sort(key=score)
    return langs[0]


def vtt_to_text(path):
    """把 vtt 字幕转成去重后的纯文本（去时间轴、序号、内联标签、连续重复行）。"""
    out = []
    prev = None
    with open(path, encoding="utf-8", errors="ignore") as fh:
        for raw in fh:
            line = raw.rstrip("\n")
            if not line or line.startswith("WEBVTT") or "-->" in line:
                continue
            if line.startswith(("Kind:", "Language:", "NOTE")):
                continue
            if re.match(r"^\d+$", line.strip()):  # 序号行
                continue
            line = re.sub(r"<[^>]+>", "", line)   # <c>/<00:00:00.000> 等标签
            line = re.sub(r"\{[^}]+\}", "", line).strip()
            if not line or line == prev:          # 自动字幕常滚动重复
                continue
            out.append(line)
            prev = line
    return "\n".join(out)


def main():
    if len(sys.argv) < 3:
        print("usage: python fetch_video.py <video_url> <output_dir>", file=sys.stderr)
        sys.exit(2)

    url = sys.argv[1]
    outdir = sys.argv[2]
    os.makedirs(outdir, exist_ok=True)

    ensure_ytdlp()
    import yt_dlp

    try:
        with yt_dlp.YoutubeDL(
            {"quiet": True, "skip_download": True, "no_warnings": True}
        ) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as exc:  # noqa: BLE001
        print("[fetch_video] ERROR 无法解析该视频：%s" % exc, file=sys.stderr)
        print("hint: 该视频可能区域受限/需要登录/链接不受支持；"
              "请改为请用户补一张队伍截图来还原阵容。", file=sys.stderr)
        sys.exit(1)

    vid = info.get("id") or "video"
    title = info.get("title") or ""
    uploader = info.get("uploader") or info.get("channel") or ""
    duration = info.get("duration")
    webpage = info.get("webpage_url") or url
    description = info.get("description") or ""

    # 选字幕：人工优先，回退自动
    lang = pick_sub_lang(info, "subtitles")
    kind = "subtitles"
    if not lang:
        lang = pick_sub_lang(info, "automatic_captions")
        kind = "automatic_captions"

    sub_text = ""
    sub_status = "none"
    if lang:
        opts = {
            "quiet": True,
            "skip_download": True,
            "no_warnings": True,
            "writesubtitles": kind == "subtitles",
            "writeautomaticsub": kind == "automatic_captions",
            "subtitleslangs": [lang],
            "subtitlesformat": "vtt",
            "outtmpl": os.path.join(outdir, "%(id)s.%(ext)s"),
        }
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                ydl.download([url])
            vtts = glob.glob(os.path.join(outdir, "%s*.vtt" % vid))
            if vtts:
                sub_text = vtt_to_text(vtts[0])
                if sub_text.strip():
                    sub_status = "%s:%s" % (kind, lang)
        except Exception as exc:  # noqa: BLE001
            print("[fetch_video] 字幕下载失败（不致命）：%s" % exc, file=sys.stderr)

    mins = "%d:%02d" % (duration // 60, duration % 60) if duration else "?"
    out_path = os.path.join(outdir, "video_%s.md" % vid)
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write("# 视频抓取结果\n\n")
        fh.write("## 元数据\n")
        fh.write("- 标题：%s\n" % title)
        fh.write("- 上传者：%s\n" % uploader)
        fh.write("- 时长：%s\n" % mins)
        fh.write("- 链接：%s\n" % webpage)
        fh.write("- 字幕状态：%s\n\n" % sub_status)
        fh.write("## 简介 (description)\n")
        fh.write((description or "(空)") + "\n\n")
        fh.write("## 字幕 (transcript)\n")
        fh.write((sub_text or "(未抓到字幕——阵容很可能需要用户补截图)") + "\n")

    # 供 piki 解析的稳定输出
    print("[fetch_video] OK")
    print("output_file: %s" % out_path)
    print("subtitles: %s" % sub_status)
    print("title: %s" % title)


if __name__ == "__main__":
    main()
