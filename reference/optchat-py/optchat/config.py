"""Small, explicit TOML configuration; secrets are read only from environment variables."""

from __future__ import annotations

import json
import math
import os
import tomllib
from dataclasses import dataclass, field, fields
from pathlib import Path
from urllib.parse import urlparse

DEFAULTS = {
    "anthropic": ("claude-sonnet-5-5", "https://api.anthropic.com/v1", "ANTHROPIC_API_KEY"),
    "openai": ("gpt-6.1-sol", "https://api.openai.com/v1", "OPENAI_API_KEY"),
    "openrouter": (
        "anthropic/claude-sonnet-5.5",
        "https://openrouter.ai/api/v1",
        "OPENROUTER_API_KEY",
    ),
    "local": ("qwen3:8b", "http://localhost:11434/v1", ""),
    "demo": ("offline-demo", "", ""),
}


@dataclass(frozen=True)
class ModelConfig:
    provider: str = "anthropic"
    model: str = ""
    base_url: str = ""
    api_key_env: str = ""
    max_tokens: int = 8192
    effort: str = "medium"
    timeout: float = 180
    # OpenAI Responses features can be disabled for older models.
    explicit_cache: bool = True
    reasoning_context: str = "all_turns"

    def __post_init__(self):
        if self.provider not in DEFAULTS:
            raise ValueError(f"Unknown provider: {self.provider}")
        for name, default in zip(("model", "base_url", "api_key_env"), DEFAULTS[self.provider]):
            if not getattr(self, name):
                object.__setattr__(self, name, default)
        if not isinstance(self.model, str) or not self.model.strip():
            raise ValueError("model must be a nonempty string")
        if type(self.max_tokens) is not int or self.max_tokens < 1:
            raise ValueError("max_tokens must be positive")
        if (
            not isinstance(self.timeout, (int, float))
            or not math.isfinite(self.timeout)
            or self.timeout <= 0
        ):
            raise ValueError("timeout must be positive and finite")
        if self.provider != "demo":
            url = urlparse(self.base_url)
            if (
                url.scheme not in ("http", "https")
                or not url.hostname
                or url.username
                or url.password
            ):
                raise ValueError("base_url must be an HTTP(S) URL without embedded credentials")
        if self.reasoning_context not in ("", "all_turns", "current_turn"):
            raise ValueError("reasoning_context must be all_turns, current_turn, or empty")

    def key(self) -> str:
        key = os.environ.get(self.api_key_env, "") if self.api_key_env else ""
        if self.provider not in ("local", "demo") and not key:
            raise ValueError(f"Set {self.api_key_env} for the {self.provider} provider")
        return key


@dataclass(frozen=True)
class MemoryConfig:
    node_bytes: int = 512
    view_bytes: int = 128_000
    jobs: int = 8
    tries: int = 5
    retry_seconds: float = 10
    tool_cap: int = 30_000

    def __post_init__(self):
        for name in ("node_bytes", "view_bytes", "jobs", "tries", "tool_cap"):
            value = getattr(self, name)
            if type(value) is not int or value < 1:
                raise ValueError(f"{name} must be a positive integer")
        if self.node_bytes < 64 or self.tool_cap < 128:
            raise ValueError("node_bytes must be >= 64 and tool_cap >= 128")
        if not math.isfinite(self.retry_seconds) or self.retry_seconds <= 0:
            raise ValueError("retry_seconds must be positive and finite")


@dataclass(frozen=True)
class ChatConfig:
    directory: Path = Path("chat")
    workspace: Path = Path(".")
    instructions: Path | None = None
    allow_shell: bool = False
    max_steps: int = 100
    memory: MemoryConfig = field(default_factory=MemoryConfig)
    agent: ModelConfig = field(default_factory=ModelConfig)
    compactor: ModelConfig = field(default_factory=lambda: ModelConfig(max_tokens=4096))


def _model(data: dict, **defaults) -> ModelConfig:
    return ModelConfig(**(defaults | data))


def load_config(path: Path) -> ChatConfig:
    if not path.exists():
        return ChatConfig(directory=Path("chat").resolve(), workspace=Path.cwd())
    with path.open("rb") as handle:
        data = tomllib.load(handle)
    unknown = set(data) - {"chat", "memory", "agent", "compactor"}
    if unknown:
        raise ValueError(f"Unknown config sections: {', '.join(sorted(unknown))}")
    chat = data.get("chat", {}).copy()
    allowed = {f.name for f in fields(ChatConfig)} - {"memory", "agent", "compactor"}
    if set(chat) - allowed:
        raise ValueError(f"Unknown chat options: {set(chat) - allowed}")
    for name, default in (("directory", "chat"), ("workspace", "."), ("instructions", None)):
        value = chat.get(name, default)
        chat[name] = (path.parent / value).resolve() if value else None
    if type(chat.get("allow_shell", False)) is not bool:
        raise ValueError("allow_shell must be true or false")
    if type(chat.get("max_steps", 100)) is not int or chat.get("max_steps", 100) < 1:
        raise ValueError("max_steps must be a positive integer")
    return ChatConfig(
        **chat,
        memory=MemoryConfig(**data.get("memory", {})),
        agent=_model(data.get("agent", {})),
        compactor=_model(data.get("compactor", {}), max_tokens=4096),
    )


def config_template(provider: str, model: str | None = None, base_url: str | None = None) -> str:
    choice = ModelConfig(provider=provider, model=model or "", base_url=base_url or "")
    # Local servers often have small default context windows; this preset fits a smaller view.
    view = 16_000 if provider == "local" else 128_000
    jobs = 1 if provider == "local" else 8
    lines = [
        "# Keys stay in environment variables, never in this file.",
        "[chat]",
        'directory = "chat"',
        'workspace = "."',
        "allow_shell = false",
        '# instructions = "my-instructions.md"',
        "max_steps = 100",
        "",
        "[memory]",
        "node_bytes = 512",
        f"view_bytes = {view}",
        f"jobs = {jobs}",
        "tries = 5",
        "retry_seconds = 10",
        "tool_cap = 30000",
        "",
    ]
    for section in ("agent", "compactor"):
        lines += [
            f"[{section}]",
            f"provider = {json.dumps(provider)}",
            f"model = {json.dumps(choice.model)}",
            f"base_url = {json.dumps(choice.base_url)}",
            f"api_key_env = {json.dumps(choice.api_key_env)}",
            'effort = "medium"',
            f"max_tokens = {8192 if section == 'agent' else 4096}",
            "timeout = 180",
            "",
        ]
    return "\n".join(lines)
