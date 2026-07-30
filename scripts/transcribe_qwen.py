#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Transcribe local media with Qwen3-ASR using bounded long-video chunks."
    )
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--transcript-id", required=True)
    parser.add_argument("--work-id", required=True)
    parser.add_argument("--source-url", required=True)
    parser.add_argument("--title", default="")
    parser.add_argument("--author", default="")
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--model-name", default="Qwen/Qwen3-ASR-1.7B")
    parser.add_argument("--language", choices=("Chinese", "auto"), default="Chinese")
    parser.add_argument("--chunk-seconds", type=int, default=90)
    parser.add_argument("--max-duration-seconds", type=int, default=7200)
    parser.add_argument("--context", default="")
    parser.add_argument("--context-version", default="")
    return parser.parse_args()


def executable(name: str) -> str:
    resolved = shutil.which(name)
    if not resolved:
        raise RuntimeError(f"{name} was not found on PATH")
    return resolved


def probe_duration(input_path: Path) -> float:
    result = subprocess.run(
        [
            executable("ffprobe"),
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(input_path),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {result.stderr[-1000:]}")
    try:
        duration = float(result.stdout.strip())
    except ValueError as exc:
        raise RuntimeError(f"ffprobe returned an invalid duration: {result.stdout!r}") from exc
    if not math.isfinite(duration) or duration <= 0:
        raise RuntimeError(f"invalid media duration: {duration}")
    return duration


def extract_chunk(
    input_path: Path,
    output_path: Path,
    start: float,
    duration: float,
) -> None:
    result = subprocess.run(
        [
            executable("ffmpeg"),
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            f"{start:.3f}",
            "-i",
            str(input_path),
            "-t",
            f"{duration:.3f}",
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            "-y",
            str(output_path),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=max(90, int(duration * 2)),
        check=False,
    )
    if result.returncode != 0 or not output_path.exists() or output_path.stat().st_size < 1000:
        raise RuntimeError(f"ffmpeg chunk extraction failed: {result.stderr[-1500:]}")


def result_value(result: Any, key: str) -> Any:
    if isinstance(result, dict):
        return result.get(key)
    return getattr(result, key, None)


def main() -> int:
    args = parse_args()
    input_path = Path(args.input).resolve()
    output_path = Path(args.output).resolve()
    model_path = Path(args.model_path).resolve()
    if not input_path.is_file():
        raise FileNotFoundError(input_path)
    if not model_path.is_dir():
        raise FileNotFoundError(model_path)
    if not 30 <= args.chunk_seconds <= 180:
        raise ValueError("chunk-seconds must be between 30 and 180")
    if not 60 <= args.max_duration_seconds <= 7200:
        raise ValueError("max-duration-seconds must be between 60 and 7200")

    import torch
    from qwen_asr import Qwen3ASRModel

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is unavailable; Qwen3-ASR-1.7B requires the NVIDIA GPU runtime")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    duration_seconds = probe_duration(input_path)
    if duration_seconds > args.max_duration_seconds:
        raise RuntimeError(
            f"VIDEO_TOO_LONG: maximum is {args.max_duration_seconds} seconds"
        )
    chunk_count = max(1, math.ceil(duration_seconds / args.chunk_seconds))
    print(
        f"Loading Qwen3-ASR model={model_path} on cuda:0; "
        f"duration={duration_seconds:.1f}s chunks={chunk_count}",
        file=sys.stderr,
        flush=True,
    )
    torch.backends.cuda.matmul.allow_tf32 = True
    model = Qwen3ASRModel.from_pretrained(
        str(model_path),
        dtype=torch.bfloat16,
        device_map="cuda:0",
        max_inference_batch_size=1,
        max_new_tokens=1024,
    )

    segments: list[dict[str, Any]] = []
    text_parts: list[str] = []
    detected_language: str | None = None
    requested_language = None if args.language == "auto" else args.language
    with tempfile.TemporaryDirectory(
        prefix="qwen-chunks-", dir=str(input_path.parent)
    ) as chunk_dir_value:
        chunk_dir = Path(chunk_dir_value)
        for index in range(chunk_count):
            start = float(index * args.chunk_seconds)
            end = min(duration_seconds, start + args.chunk_seconds)
            chunk_path = chunk_dir / f"chunk-{index:05d}.wav"
            extract_chunk(input_path, chunk_path, start, end - start)
            print(
                f"Transcribing chunk {index + 1}/{chunk_count} "
                f"[{start:.1f}, {end:.1f}]",
                file=sys.stderr,
                flush=True,
            )
            results = model.transcribe(
                audio=str(chunk_path),
                context=args.context,
                language=requested_language,
            )
            if not results:
                chunk_path.unlink(missing_ok=True)
                continue
            text = str(result_value(results[0], "text") or "").strip()
            language = result_value(results[0], "language")
            if language and not detected_language:
                detected_language = str(language)
            if text:
                segments.append(
                    {
                        "index": len(segments),
                        "start": round(start, 3),
                        "end": round(end, 3),
                        "text": text,
                    }
                )
                text_parts.append(text)
            chunk_path.unlink(missing_ok=True)
            torch.cuda.empty_cache()

    if not segments:
        raise RuntimeError("Qwen3-ASR returned no usable text segments")

    record = {
        "transcriptId": args.transcript_id,
        "workId": args.work_id,
        "sourceUrl": args.source_url,
        "title": args.title,
        "author": args.author or None,
        "model": args.model_name,
        "method": "local-qwen3-asr",
        "language": detected_language or requested_language,
        "durationSeconds": round(duration_seconds, 3),
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "device": torch.cuda.get_device_name(0),
        "computeType": "bfloat16",
        "requestedLanguage": args.language,
        "chunkSeconds": args.chunk_seconds,
        "contextApplied": bool(args.context),
        "contextVersion": args.context_version or None,
        "text": "\n".join(text_parts),
        "segments": segments,
    }
    output_path.write_text(
        json.dumps(record, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "ok": True,
                "segments": len(segments),
                "language": record["language"],
                "durationSeconds": record["durationSeconds"],
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"QWEN_TRANSCRIBE_ERROR: {exc}", file=sys.stderr)
        raise
