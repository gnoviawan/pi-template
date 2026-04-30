from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKAGES = {
    "auto-session-name": {
        "name": "@gnoviawan/pi-auto-session-name",
        "description": "Automatically titles sessions using a custom name_session tool.",
        "peerDependencies": {
            "@mariozechner/pi-coding-agent": "*",
            "@sinclair/typebox": "*",
        },
    },
    "biome-lsp": {
        "name": "@gnoviawan/pi-biome-lsp",
        "description": "Biome lint/format/check integration for Pi, including daemon startup and post-edit checks.",
        "peerDependencies": {
            "@mariozechner/pi-coding-agent": "*",
            "@sinclair/typebox": "*",
        },
        "dependencies": {
            "@biomejs/biome": "^2.0.0",
        },
    },
    "compact-tool-preview": {
        "name": "@gnoviawan/pi-compact-tool-preview",
        "description": "Compact single-line renderers for Pi built-in tools.",
        "peerDependencies": {
            "@mariozechner/pi-coding-agent": "*",
            "@mariozechner/pi-tui": "*",
        },
    },
    "session-delete": {
        "name": "@gnoviawan/pi-session-delete",
        "description": "Interactive session deletion command for Pi.",
        "peerDependencies": {
            "@mariozechner/pi-coding-agent": "*",
            "@mariozechner/pi-tui": "*",
        },
    },
    "session-usage": {
        "name": "@gnoviawan/pi-session-usage",
        "description": "Tracks time usage, prompts, turns, and tool calls in a session.",
        "peerDependencies": {
            "@mariozechner/pi-coding-agent": "*",
        },
    },
    "setup-providers": {
        "name": "@gnoviawan/pi-setup-providers",
        "description": "Overlay wizard for custom providers and model setup.",
        "peerDependencies": {
            "@mariozechner/pi-coding-agent": "*",
            "@mariozechner/pi-tui": "*",
        },
    },
    "token-usage": {
        "name": "@gnoviawan/pi-token-usage",
        "description": "Displays session and project token usage across Pi sessions.",
        "peerDependencies": {
            "@mariozechner/pi-coding-agent": "*",
            "@mariozechner/pi-tui": "*",
        },
    },
    "tokens-per-second": {
        "name": "@gnoviawan/pi-tokens-per-second",
        "description": "Shows rolling tokens-per-second in the Pi status bar.",
        "peerDependencies": {
            "@mariozechner/pi-coding-agent": "*",
        },
    },
}

for directory, config in PACKAGES.items():
    package_dir = ROOT / "packages" / directory
    (package_dir / "extensions").mkdir(parents=True, exist_ok=True)

    package_json = {
        "name": config["name"],
        "version": "0.1.0",
        "private": False,
        "keywords": ["pi-package"],
        "peerDependencies": config["peerDependencies"],
        "pi": {"extensions": ["./extensions"]},
    }
    if "dependencies" in config:
        package_json["dependencies"] = config["dependencies"]

    (package_dir / "package.json").write_text(
        json.dumps(package_json, indent=2) + "\n",
        encoding="utf-8",
    )
    (package_dir / "README.md").write_text(
        f"# {config['name']}\n\n{config['description']}\n\nThis package is part of the `pi-template` monorepo and is installable as a Pi package.\n",
        encoding="utf-8",
    )
