#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="Download Qwen3-ASR from ModelScope.")
    parser.add_argument("--model", default="Qwen/Qwen3-ASR-1.7B")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    from modelscope.hub.snapshot_download import snapshot_download

    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    result = snapshot_download(args.model, local_dir=str(output))
    print(result)
    required = (
        "config.json",
        "model.safetensors.index.json",
        "model-00001-of-00002.safetensors",
        "model-00002-of-00002.safetensors",
    )
    missing = [name for name in required if not (output / name).is_file()]
    if missing:
        raise RuntimeError(f"model download did not produce required files: {missing}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
