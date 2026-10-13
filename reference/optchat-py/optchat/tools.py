"""Memory navigation and explicitly scoped local work tools."""

from __future__ import annotations

import asyncio
import codecs
import os
import signal
import tempfile
from pathlib import Path

from .memory import Memory


def definition(name, description, **properties):
    return {
        "name": name,
        "description": description,
        "parameters": {
            "type": "object",
            "properties": properties,
            "required": list(properties),
            "additionalProperties": False,
        },
    }


INTEGER = {"type": "integer"}
STRING = {"type": "string"}


def cap_text(text: str, limit: int = 30_000) -> str:
    if len(text) <= limit:
        return text
    keep = limit
    while True:
        marker = f"\n... [{len(text) - keep} characters omitted] ...\n"
        new_keep = max(0, limit - len(marker))
        if new_keep == keep:
            break
        keep = new_keep
    head = (keep + 1) // 2
    tail = keep // 2
    return text[:head] + marker + (text[-tail:] if tail else "")


class BoundedOutput:
    """Keep head and tail while draining arbitrary process output in bounded RAM."""

    def __init__(self, limit: int):
        self.limit = limit
        self.head = ""
        self.tail = ""
        self.total = 0

    def add(self, text: str):
        self.total += len(text)
        available = self.limit - len(self.head)
        self.head += text[:available]
        self.tail = (self.tail + text[available:])[-self.limit :]

    def render(self):
        if self.total <= self.limit:
            return self.head
        keep = self.limit
        while True:
            marker = f"\n... [{self.total - keep} characters omitted] ...\n"
            remaining = self.limit - len(marker)
            if remaining == keep:
                break
            keep = remaining
        head = (keep + 1) // 2
        tail = keep // 2
        end = (self.head + self.tail)[-tail:] if tail else ""
        return self.head[:head] + marker + end


class Toolset:
    def __init__(
        self, memory: Memory, workspace: Path, *, allow_shell: bool = False, cap: int = 30_000
    ):
        self.memory = memory
        self.workspace = workspace.resolve()
        self.allow_shell = allow_shell
        self.cap = cap
        if not self.workspace.is_dir():
            raise ValueError(f"Workspace is not a directory: {self.workspace}")
        self.definitions = [
            definition(
                "zoom",
                "Open the line id+n of the view into the two lines of n/2 under "
                "it; n = 1 gives the message whole.",
                id=INTEGER,
                n=INTEGER,
            ),
            definition("date", "The date and time of message id.", id=INTEGER),
            definition(
                "list_files",
                "List immediate files and directories within the workspace.",
                path=STRING,
            ),
            definition(
                "read_file",
                "Read UTF-8 file lines within the workspace. start_line is "
                "1-based; use line_count <= 1000. Read additional ranges as needed.",
                path=STRING,
                start_line=INTEGER,
                line_count=INTEGER,
            ),
            definition(
                "write_file",
                "Create or replace a UTF-8 file within the workspace. "
                "The chat's memory directory is protected.",
                path=STRING,
                content=STRING,
            ),
        ]
        if allow_shell:
            self.definitions.append(
                definition(
                    "run_shell",
                    "Run a bash command in the workspace. "
                    "This is NOT sandboxed. timeout_seconds must be 1-300.",
                    command=STRING,
                    timeout_seconds=INTEGER,
                )
            )

    def _path(self, value: str, *, writing: bool = False) -> Path:
        path = (self.workspace / value).resolve()
        if not path.is_relative_to(self.workspace):
            raise ValueError("Path escapes the configured workspace")
        if writing and (
            path.is_relative_to(self.memory.store.path)
            or self.memory.store.path.is_relative_to(path)
        ):
            raise ValueError("The append-only memory directory is protected")
        return path

    async def execute(self, name: str, arguments: dict) -> str:
        spec = next((t for t in self.definitions if t["name"] == name), None)
        if spec is None:
            raise ValueError(f"Unknown or disabled tool: {name}")
        props = spec["parameters"]["properties"]
        if not isinstance(arguments, dict) or set(arguments) != set(props):
            raise ValueError(f"Expected exactly these arguments: {', '.join(props)}")
        for key, schema in props.items():
            expected = int if schema["type"] == "integer" else str
            if type(arguments[key]) is not expected:
                raise ValueError(f"{key} must be {schema['type']}")
        if name == "zoom":
            # Exact retrieval is deliberately exempt from the workspace tool-output cap.
            return self.memory.zoom(**arguments)
        if name == "date":
            return self.memory.date(**arguments)
        if name == "list_files":
            path = self._path(arguments["path"])
            result = (
                "\n".join(
                    p.name + ("/" if p.is_dir() else "")
                    for p in sorted(path.iterdir(), key=lambda p: p.name)
                )
                or "(empty directory)"
            )
        elif name == "read_file":
            path = self._path(arguments["path"])
            start, count = arguments["start_line"], arguments["line_count"]
            if start < 1 or not 1 <= count <= 1000:
                raise ValueError("start_line >= 1; line_count between 1 and 1000")
            if not path.is_file():
                raise ValueError("Expected a regular file")
            output = BoundedOutput(self.cap)
            with path.open(encoding="utf-8") as handle:
                for number, line in enumerate(handle, 1):
                    if number < start:
                        continue
                    if number >= start + count:
                        break
                    output.add(f"{number}: {line}")
            result = output.render() or "(no lines in this range)"
        elif name == "write_file":
            path = self._path(arguments["path"], writing=True)
            path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(prefix=".optchat-write-", dir=path.parent)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    handle.write(arguments["content"])
                    handle.flush()
                    os.fsync(handle.fileno())
                if path.exists():
                    os.chmod(tmp, path.stat().st_mode & 0o777)
                os.replace(tmp, path)
                self.memory.store._sync_directory(path.parent)
            finally:
                if os.path.exists(tmp):
                    os.unlink(tmp)
            result = (
                f"Wrote {len(arguments['content'].encode('utf-8'))} bytes to {arguments['path']}"
            )
        else:
            result = await self._shell(**arguments)
        return cap_text(result, self.cap)

    async def _shell(self, command: str, timeout_seconds: int) -> str:
        if not 1 <= timeout_seconds <= 300:
            raise ValueError("timeout_seconds must be between 1 and 300")
        process = await asyncio.create_subprocess_exec(
            "/bin/bash",
            "-lc",
            command,
            cwd=self.workspace,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            start_new_session=True,
        )
        output = BoundedOutput(self.cap - 32)
        decoder = codecs.getincrementaldecoder("utf-8")("replace")

        async def read():
            while chunk := await process.stdout.read(8192):
                output.add(decoder.decode(chunk))
            output.add(decoder.decode(b"", final=True))
            await process.wait()

        timed_out = False
        cancelled = False
        try:
            await asyncio.wait_for(read(), timeout_seconds)
        except TimeoutError:
            timed_out = True
        except asyncio.CancelledError:
            cancelled = True
            raise
        finally:
            # Kill the entire process group, including children keeping the pipe open.
            if process.returncode is None or timed_out or cancelled:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                await process.wait()
        status = "Timed out" if timed_out else f"Exit {process.returncode}"
        return f"{status}\n{output.render()}"
