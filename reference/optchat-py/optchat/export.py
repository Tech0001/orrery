"""A self-contained, escaped HTML memory browser and portable history backups."""

from __future__ import annotations

import html
import os
import tarfile
from pathlib import Path

from .memory import Memory
from .storage import Part, children


def _destination(path: Path, memory: Memory):
    path = path.resolve()
    if path.is_relative_to(memory.store.path):
        raise ValueError("Export outside the chat directory to protect append-only memory")
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def export_html(memory: Memory, path: Path) -> Path:
    path = _destination(path, memory)
    escape = html.escape

    def entry(part: Part, text: str, size: int, *, raw=False, view=False):
        root = memory.store.root
        start, end = root[part.start].date, root[part.end - 1].date
        anchor = (
            f"message-{part.start}" if raw else f"{'view' if view else 'node'}-{part.l}-{part.i}"
        )
        if raw:
            links = ""
        elif part.l == 0:
            links = f'<a href="#message-{part.start}">Open original message →</a>'
        else:
            links = " · ".join(
                f'<a href="#node-{c.l}-{c.i}">Open {c.address} →</a>' for c in children(part)
            )
        label = f"Message {part.start} · {root[part.start].kind}" if raw else part.address
        return (
            f'<article class="entry" id="{anchor}"><header><strong>{escape(label)}</strong>'
            f"<span>{size:,} bytes · {escape(start)}"
            f"{' → ' + escape(end) if end != start else ''}</span></header>"
            f"<pre>{escape(text)}</pre><footer>{links}</footer></article>"
        )

    view = "\n".join(
        entry(p, memory.text(p), len(memory.text(p).encode()), view=True) for p in memory.view
    )
    root = "\n".join(entry(Part(0, m.i), m.text, m.size, raw=True) for m in memory.store.root)
    levels = []
    for level in sorted({p.l for p in memory.store.nodes}, reverse=True):
        rows = "\n".join(
            entry(p, node.text, node.size)
            for p, node in sorted(memory.store.nodes.items(), key=lambda pair: pair[0].i)
            if p.l == level
        )
        levels.append(f"<h2>Level {level} · {1 << level} messages per node</h2>{rows}")
    stats = memory.stats()
    document = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OptChat · Memory</title><style>
:root{color-scheme:light dark;font:16px/1.6 system-ui,sans-serif;background:#111719;color:#e2e9e6}
*{box-sizing:border-box}body{max-width:1100px;margin:auto;padding:32px 24px 80px}
h1{font-size:36px;letter-spacing:-1px;margin:0}h2{font-size:20px;margin-top:32px}
.eyebrow{color:#7fcba8;font:12px monospace;letter-spacing:2px}p{color:#a9b9b1}
nav{display:flex;flex-wrap:wrap;gap:10px;margin:24px 0}button,input{font:inherit;border:1px solid #40554a;border-radius:8px;padding:8px 14px;background:#17231e;color:inherit}
button{cursor:pointer}button[aria-selected=true]{background:#b5edcf;color:#13231a}input{width:100%;margin-bottom:18px}
.entry{border:1px solid #304239;border-radius:10px;padding:18px;margin:14px 0;background:#16201b;scroll-margin-top:18px}
.entry:target{outline:2px solid #b5edcf}header{display:flex;gap:12px;justify-content:space-between;flex-wrap:wrap}
header span{font-size:12px;color:#9db3a6}pre{font:14px/1.7 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
a{color:#99dbb7}footer{font-size:13px}section[hidden],article[hidden]{display:none}
@media(prefers-color-scheme:light){:root{background:#f4f7f4;color:#172d23}.entry{background:white;border-color:#ceddd3}p,header span{color:#536d5f}a,.eyebrow{color:#25734d}button,input{background:white;color:#172d23;border-color:#b3cabc}}
</style></head><body><div class="eyebrow">OPTCHAT / LOCAL MEMORY</div><h1>The whole conversation.</h1>
"""
    document += (
        f"<p>{stats['messages']:,} messages · {stats['nodes']:,} summaries · "
        f"{stats['view_bytes']:,} / {stats['view_budget']:,} view bytes. "
        "This is a local snapshot. Original messages remain unchanged.</p>"
        '<nav aria-label="Memory sections"><button data-tab="view" aria-selected="true">Current view</button>'
        '<button data-tab="root" aria-selected="false">All messages</button>'
        '<button data-tab="tree" aria-selected="false">Summary tree</button></nav>'
        '<label for="search">Filter this section</label><input id="search" type="search" placeholder="Search words, paths, decisions…">'
        f'<section id="view">{view or "<p>No messages yet.</p>"}</section>'
        f'<section id="root" hidden>{root}</section>'
        f'<section id="tree" hidden>{"".join(levels)}</section>'
    )
    document += """<script>
const sections=[...document.querySelectorAll('section')], buttons=[...document.querySelectorAll('[data-tab]')], search=document.querySelector('#search');
function filter(){const q=search.value.toLowerCase();document.querySelectorAll('.entry').forEach(e=>e.hidden=!e.textContent.toLowerCase().includes(q));}
function show(id){sections.forEach(s=>s.hidden=s.id!==id);buttons.forEach(b=>b.setAttribute('aria-selected',String(b.dataset.tab===id)));filter();}
buttons.forEach(b=>b.addEventListener('click',()=>show(b.dataset.tab)));search.addEventListener('input',filter);
function navigate(){const target=document.getElementById(location.hash.slice(1));if(target&&target.closest('section')){search.value='';show(target.closest('section').id);target.scrollIntoView();}}
addEventListener('hashchange',navigate);navigate();
</script></body></html>"""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(document)
        handle.flush()
        os.fsync(handle.fileno())
    return path


def backup(memory: Memory, path: Path) -> Path:
    path = _destination(path, memory)
    # Exclusive creation prevents accidentally replacing an earlier backup.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as handle:
        with tarfile.open(fileobj=handle, mode="w:gz") as archive:
            for stream in ("main", "tree"):
                archive.add(memory.store.path / stream, arcname=f"chat/{stream}")
            profile = memory.store.path / "profile.json"
            if profile.exists():
                archive.add(profile, arcname="chat/profile.json")
        handle.flush()
        os.fsync(handle.fileno())
    return path
