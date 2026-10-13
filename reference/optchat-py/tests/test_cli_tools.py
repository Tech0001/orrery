import asyncio
import json
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

from optchat.cli import ingest
from optchat.config import config_template, load_config
from optchat.export import backup, export_html
from optchat.memory import Memory
from optchat.storage import Store
from optchat.tools import BoundedOutput, Toolset, cap_text


class ToolTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.workspace = Path(self.temp.name)
        self.store = Store(self.workspace / "chat")
        self.addCleanup(self.store.close)
        self.memory = Memory(self.store)
        self.tools = Toolset(self.memory, self.workspace)

    async def test_workspace_read_write_and_list(self):
        output = await self.tools.execute(
            "write_file", {"path": "notes/a.txt", "content": "one\ntwo\nthree\n"}
        )
        self.assertIn("Wrote", output)
        output = await self.tools.execute(
            "read_file", {"path": "notes/a.txt", "start_line": 2, "line_count": 1}
        )
        self.assertEqual(output, "2: two\n")
        self.assertEqual(await self.tools.execute("list_files", {"path": "notes"}), "a.txt")

    async def test_paths_symlinks_and_memory_are_protected(self):
        for path in ("../escape.txt", "/etc/passwd", "chat/main/test.jsonl", "chat/lock"):
            with self.assertRaises(ValueError):
                await self.tools.execute("write_file", {"path": path, "content": "no"})
        (self.workspace / "escape").symlink_to("/tmp", target_is_directory=True)
        with self.assertRaises(ValueError):
            await self.tools.execute("write_file", {"path": "escape/outside", "content": "no"})
        with self.assertRaisesRegex(ValueError, "disabled"):
            await self.tools.execute("run_shell", {"command": "true", "timeout_seconds": 1})

    async def test_argument_validation_rejects_bool_and_unknown_fields(self):
        with self.assertRaises(ValueError):
            await self.tools.execute("zoom", {"id": True, "n": 1})
        with self.assertRaises(ValueError):
            await self.tools.execute("date", {"id": 0, "other": "x"})

    async def test_shell_bounded_output_and_timeout(self):
        tools = Toolset(self.memory, self.workspace, allow_shell=True, cap=200)
        output = await tools.execute(
            "run_shell", {"command": "printf 'hello'", "timeout_seconds": 1}
        )
        self.assertEqual(output, "Exit 0\nhello")
        output = await tools.execute("run_shell", {"command": "sleep 5", "timeout_seconds": 1})
        self.assertIn("Timed out", output)
        self.assertLessEqual(len(output), 200)

    async def test_shell_cancellation_terminates_child(self):
        tools = Toolset(self.memory, self.workspace, allow_shell=True)
        task = asyncio.create_task(
            tools.execute("run_shell", {"command": "sleep 30", "timeout_seconds": 60})
        )
        await asyncio.sleep(0.05)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(task, 2)

    def test_head_tail_cap_unicode_and_streaming_match(self):
        text = "你好" * 300 + "THE END"
        capped = cap_text(text, 200)
        self.assertEqual(len(capped), 200)
        self.assertTrue(capped.endswith("THE END"))
        self.assertTrue(capped.startswith("你好"))
        stream = BoundedOutput(200)
        for i in range(0, len(text), 7):
            stream.add(text[i : i + 7])
        self.assertEqual(stream.render(), capped)

    def test_import_preserves_ids_dates_and_validates_before_writing(self):
        source = self.workspace / "old.jsonl"
        rows = [
            {"i": 0, "kind": "user", "text": "old", "date": "2024-01-01T12:00:00+00:00"},
            {"i": 1, "role": "assistant", "content": "reply"},
        ]
        source.write_text("\n".join(json.dumps(row) for row in rows))
        self.assertEqual(ingest(self.memory, source), 2)
        self.assertEqual(self.store.root[0].date, rows[0]["date"])
        self.assertEqual(self.store.root[1].kind, "talk")
        source.write_text('{"text":"would be valid"}\n{"text":42}\n')
        with self.assertRaises(ValueError):
            ingest(self.memory, source)
        self.assertEqual(len(self.store.root), 2)

    def test_html_escapes_history_and_backup_round_trip(self):
        self.memory.append("user", '<script>alert("x")</script>')
        page = export_html(self.memory, self.workspace / "memory.html")
        html = page.read_text()
        self.assertIn("&lt;script&gt;", html)
        self.assertNotIn('<script>alert("x")', html)
        self.assertIn('id="message-0"', html)
        archive = backup(self.memory, self.workspace / "backup.tar.gz")
        with tarfile.open(archive) as handle:
            names = handle.getnames()
            self.assertNotIn("chat/lock", names)
            member = next(name for name in names if name.endswith(".jsonl"))
            row = json.loads(handle.extractfile(member).read())
            self.assertEqual(row["text"], self.store.root[0].text)
        with self.assertRaises(FileExistsError):
            backup(self.memory, archive)
        with self.assertRaises(ValueError):
            export_html(self.memory, self.store.path / "main/a.jsonl")


class CliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)

    def invoke(self, *args, input=None):
        return subprocess.run(
            [sys.executable, "-m", "optchat", "--config", str(self.path / "optchat.toml"), *args],
            input=input,
            text=True,
            capture_output=True,
            timeout=10,
            check=False,
        )

    def test_config_providers_and_local_defaults(self):
        for name in ("anthropic", "openai", "openrouter", "local", "demo"):
            path = self.path / f"{name}.toml"
            path.write_text(config_template(name))
            config = load_config(path)
            self.assertEqual(config.agent.provider, name)
            self.assertEqual(config.directory, self.path / "chat")
            if name == "local":
                self.assertEqual(config.memory.jobs, 1)
                self.assertEqual(config.memory.view_bytes, 16_000)

    def test_cli_demo_restart_zoom_browse_backup(self):
        result = self.invoke("init", "--provider", "demo")
        self.assertEqual(result.returncode, 0, result.stderr)
        result = self.invoke("ask", "Remember the launch code: CEDAR-42")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("no AI inference", result.stdout)
        result = self.invoke("ask", "zoom 0 1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("CEDAR-42", result.stdout)
        result = self.invoke("status")
        stats = json.loads(result.stdout)
        self.assertEqual(stats["messages"], 6)
        self.assertTrue(stats["settled"])
        page = self.path / "memory.html"
        self.assertEqual(self.invoke("browse", str(page)).returncode, 0)
        self.assertTrue(page.exists())
        self.assertEqual(self.invoke("backup", str(self.path / "memory.tar.gz")).returncode, 0)

    def test_piped_interactive_eof_finishes_accepted_messages(self):
        result = self.invoke("demo", input="a multiline idea\n/paste\nline one\nline two\n/end\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        files = list((self.path / ".optchat/demo/main").glob("*.jsonl"))
        messages = [json.loads(line) for file in files for line in file.read_text().splitlines()]
        self.assertEqual(
            [m["text"] for m in messages if m["kind"] == "user"],
            ["a multiline idea", "line one\nline two"],
        )

    def test_init_never_overwrites_and_unknown_config_is_rejected(self):
        self.assertEqual(self.invoke("init").returncode, 0)
        self.assertEqual(self.invoke("init").returncode, 1)
        (self.path / "optchat.toml").write_text("[typo]\nfoo = 1\n")
        result = self.invoke("status")
        self.assertEqual(result.returncode, 1)
        self.assertIn("Unknown config", result.stderr)
