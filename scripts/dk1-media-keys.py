#!/usr/bin/env python3
"""DK1 operator helper for Open Design media-provider credentials.

Account creation itself cannot be automated (email verification, billing,
CAPTCHA) — but everything after that can be:

  python3 scripts/dk1-media-keys.py open      # open every API-key page in the browser
  python3 scripts/dk1-media-keys.py setup     # paste keys; merged into .od/media-config.json
  python3 scripts/dk1-media-keys.py verify     # ping each provider to confirm the key works
  python3 scripts/dk1-media-keys.py status     # show which providers are configured

Keys are written ONLY to <repo>/.od/media-config.json (git-ignored,
daemon-scoped). Existing entries are preserved — pressing Enter on a
prompt leaves that provider untouched. Provision every account under
dk1.ai.official@gmail.com per DK1 governance.
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from getpass import getpass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = REPO_ROOT / ".od" / "media-config.json"


@dataclass(frozen=True)
class Provider:
    """A media provider that Open Design ships a working adapter for."""

    key: str  # media-config.json provider id
    name: str
    use: str
    signup_url: str
    key_format: str
    # ("GET", url, auth) where auth is "bearer" | "query" | "key" | None.
    # url may contain {KEY}. None = no free auth-check endpoint.
    verify: tuple[str, str, str | None] | None = field(default=None)
    optional: bool = False


PROVIDERS: list[Provider] = [
    Provider(
        key="openai",
        name="OpenAI",
        use="gpt-image-2 hero images / OG cards + gpt-4o-mini-tts voiceover",
        signup_url="https://platform.openai.com/api-keys",
        key_format="starts with 'sk-'",
        verify=("GET", "https://api.openai.com/v1/models", "bearer"),
    ),
    Provider(
        key="nanobanana",
        name="Google AI Studio (Nano Banana image)",
        use="gemini image — instruction-following + image-to-image edits",
        signup_url="https://aistudio.google.com/app/apikey",
        key_format="starts with 'AIza'",
        verify=(
            "GET",
            "https://generativelanguage.googleapis.com/v1beta/models?key={KEY}",
            "query",
        ),
    ),
    Provider(
        key="grok",
        name="xAI Grok Imagine",
        use="grok-imagine image + 720p video with native audio",
        signup_url="https://console.x.ai",
        key_format="starts with 'xai-'",
        verify=("GET", "https://api.x.ai/v1/models", "bearer"),
    ),
    Provider(
        key="imagerouter",
        name="ImageRouter",
        use="one key routes FLUX 1.1 Pro (image) + Veo 3.1 Lite (video) + routed Grok",
        signup_url="https://imagerouter.io",
        key_format="opaque token",
        verify=("GET", "https://api.imagerouter.io/v1/openai/models", "bearer"),
    ),
    Provider(
        key="higgsfield",
        name="Higgsfield (DoP cinematic image-to-video)",
        use="animate a still image with cinematic camera moves",
        signup_url="https://higgsfield.ai",
        key_format="KEY_ID:KEY_SECRET — paste BOTH parts including the colon",
        # A bogus request-status GET: 401/403 => bad key, anything else => key accepted.
        verify=(
            "GET",
            "https://platform.higgsfield.ai/requests/"
            "00000000-0000-0000-0000-000000000000/status",
            "key",
        ),
    ),
    Provider(
        key="minimax",
        name="MiniMax",
        use="text-to-speech voiceover",
        signup_url="https://platform.minimaxi.com",
        key_format="long opaque token",
    ),
    Provider(
        key="fishaudio",
        name="FishAudio",
        use="text-to-speech / voice clone",
        signup_url="https://fish.audio/go-api/",
        key_format="long opaque token",
        verify=("GET", "https://api.fish.audio/model", "bearer"),
    ),
    Provider(
        key="tavily",
        name="Tavily",
        use="agent-callable web research before generating",
        signup_url="https://app.tavily.com/home",
        key_format="starts with 'tvly-'",
    ),
    Provider(
        key="volcengine",
        name="Volcengine Ark (Seedance 2.0 video / Seedream image)",
        use="fast t2v+i2v+audio video and image — needs a China-cloud account (KYC)",
        signup_url="https://console.volcengine.com/ark",
        key_format="opaque token",
        optional=True,
    ),
]


def load_config() -> dict:
    """Read media-config.json, returning {'providers': {...}}."""
    if not CONFIG_PATH.exists():
        return {"providers": {}}
    try:
        data = json.loads(CONFIG_PATH.read_text("utf-8"))
    except json.JSONDecodeError:
        sys.exit(f"error: {CONFIG_PATH} is not valid JSON — fix or delete it first")
    if not isinstance(data, dict) or not isinstance(data.get("providers"), dict):
        return {"providers": {}}
    return data


def save_config(config: dict) -> None:
    """Write media-config.json with pretty indentation."""
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(config, indent=2) + "\n", "utf-8")


def cmd_open() -> None:
    """Open every provider's API-key page in the default browser."""
    import subprocess

    for p in PROVIDERS:
        tag = " (optional)" if p.optional else ""
        print(f"  opening {p.name}{tag} -> {p.signup_url}")
        subprocess.run(["open", p.signup_url], check=False)
    print("\nSign up / sign in under dk1.ai.official@gmail.com, then run: setup")


def cmd_setup() -> None:
    """Prompt for each key and merge into media-config.json."""
    config = load_config()
    providers = config["providers"]
    print(f"Writing to {CONFIG_PATH}")
    print("Press Enter to skip a provider (keeps any existing key).\n")

    changed = 0
    for p in PROVIDERS:
        existing = providers.get(p.key, {})
        has = bool(isinstance(existing, dict) and existing.get("apiKey"))
        tag = " [OPTIONAL]" if p.optional else ""
        state = "configured" if has else "not set"
        print(f"--- {p.name}{tag}  ({state})")
        print(f"    use:    {p.use}")
        print(f"    key:    {p.key_format}")
        print(f"    get it: {p.signup_url}")
        entered = getpass(f"    paste {p.key} key (Enter=skip): ").strip()
        if entered:
            providers[p.key] = {"apiKey": entered}
            changed += 1
            print("    -> stored\n")
        else:
            print("    -> unchanged\n")

    if changed:
        save_config(config)
        print(f"Saved {changed} key(s) to {CONFIG_PATH}")
        print("Run 'verify' next, then restart the daemon to refresh Settings.")
    else:
        print("No changes.")


def _http_get(url: str, headers: dict[str, str]) -> tuple[int, str]:
    """Best-effort GET; returns (status, short-body). status -1 on transport error."""
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, resp.read(200).decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(200).decode("utf-8", "replace")
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return -1, str(exc)


def _check(provider: Provider, api_key: str) -> tuple[str, str]:
    """Return (verdict, detail) for one provider's key."""
    if provider.verify is None:
        return "stored", "no free check endpoint — verify by generating in the UI"
    _, url, auth = provider.verify
    headers: dict[str, str] = {}
    if auth == "bearer":
        headers["Authorization"] = f"Bearer {api_key}"
    elif auth == "key":
        headers["Authorization"] = f"Key {api_key}"
    elif auth == "query":
        url = url.replace("{KEY}", urllib.parse.quote(api_key))
    status, body = _http_get(url, headers)
    if status == -1:
        return "error", f"network error: {body}"
    if status in (401, 403):
        return "bad key", f"HTTP {status} — credential rejected"
    if 200 <= status < 300:
        return "ok", f"HTTP {status}"
    # Higgsfield's bogus-UUID probe: a 404 means the key was accepted.
    if provider.key == "higgsfield" and status == 404:
        return "ok", "HTTP 404 — key accepted (probe id not found, as expected)"
    return "stored", f"HTTP {status} — inconclusive, verify in the UI"


def cmd_verify() -> None:
    """Ping every configured provider to confirm its key works."""
    providers = load_config()["providers"]
    print(f"Verifying keys in {CONFIG_PATH}\n")
    any_configured = False
    for p in PROVIDERS:
        entry = providers.get(p.key, {})
        api_key = entry.get("apiKey") if isinstance(entry, dict) else None
        if not api_key:
            print(f"  - {p.key:12s} not set")
            continue
        any_configured = True
        verdict, detail = _check(p, api_key)
        print(f"  - {p.key:12s} {verdict:8s} {detail}")
    if not any_configured:
        print("  (no keys configured yet — run 'setup' first)")


def cmd_status() -> None:
    """Show which providers are configured without contacting the network."""
    providers = load_config()["providers"]
    print(f"Config: {CONFIG_PATH}\n")
    for p in PROVIDERS:
        entry = providers.get(p.key, {})
        api_key = entry.get("apiKey") if isinstance(entry, dict) else None
        tail = f"...{api_key[-4:]}" if api_key else ""
        mark = "set " if api_key else "----"
        tag = " (optional)" if p.optional else ""
        print(f"  [{mark}] {p.key:12s} {tail:8s} {p.name}{tag}")


def main() -> None:
    commands = {
        "open": cmd_open,
        "setup": cmd_setup,
        "verify": cmd_verify,
        "status": cmd_status,
    }
    cmd = sys.argv[1] if len(sys.argv) > 1 else "setup"
    handler = commands.get(cmd)
    if handler is None:
        sys.exit(f"usage: {sys.argv[0]} [{' | '.join(commands)}]")
    handler()


if __name__ == "__main__":
    main()
