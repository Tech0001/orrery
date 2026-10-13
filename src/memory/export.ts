/** A self-contained, escaped HTML memory browser (port of the Python export_html). No network requests. */

import { children, Part } from "./types.ts";
import type { MemoryView } from "./view.ts";

function escape(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#x27;");
}

const STYLE = `:root{color-scheme:light dark;font:16px/1.6 system-ui,sans-serif;background:#111719;color:#e2e9e6}
*{box-sizing:border-box}body{max-width:1100px;margin:auto;padding:32px 24px 80px}
h1{font-size:36px;letter-spacing:-1px;margin:0}h2{font-size:20px;margin-top:32px}
.eyebrow{color:#7fcba8;font:12px monospace;letter-spacing:2px}p{color:#a9b9b1}
nav{display:flex;flex-wrap:wrap;gap:10px;margin:24px 0}button,input{font:inherit;border:1px solid #40554a;border-radius:8px;padding:8px 14px;background:#17231e;color:inherit}
button{cursor:pointer}button[aria-selected=true]{background:#b5edcf;color:#13231a}input{width:100%;margin-bottom:18px}
.entry{border:1px solid #304239;border-radius:10px;padding:18px;margin:14px 0;background:#16201b;scroll-margin-top:18px}
.entry:target{outline:2px solid #b5edcf}header{display:flex;gap:12px;justify-content:space-between;flex-wrap:wrap}
header span{font-size:12px;color:#9db3a6}pre{font:14px/1.7 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
a{color:#99dbb7}footer{font-size:13px}section[hidden],article[hidden]{display:none}
@media(prefers-color-scheme:light){:root{background:#f4f7f4;color:#172d23}.entry{background:white;border-color:#ceddd3}p,header span{color:#536d5f}a,.eyebrow{color:#25734d}button,input{background:white;color:#172d23;border-color:#b3cabc}}`;

const SCRIPT = `const sections=[...document.querySelectorAll('section')], buttons=[...document.querySelectorAll('[data-tab]')], search=document.querySelector('#search');
function filter(){const q=search.value.toLowerCase();document.querySelectorAll('.entry').forEach(e=>e.hidden=!e.textContent.toLowerCase().includes(q));}
function show(id){sections.forEach(s=>s.hidden=s.id!==id);buttons.forEach(b=>b.setAttribute('aria-selected',String(b.dataset.tab===id)));filter();}
buttons.forEach(b=>b.addEventListener('click',()=>show(b.dataset.tab)));search.addEventListener('input',filter);
function navigate(){const target=document.getElementById(location.hash.slice(1));if(target&&target.closest('section')){search.value='';show(target.closest('section').id);target.scrollIntoView();}}
addEventListener('hashchange',navigate);navigate();`;

export function renderMemoryHtml(view: MemoryView, title: string): string {
	const root = view.store.root;
	const entry = (part: Part, text: string, size: number, mode: "raw" | "view" | "node") => {
		const start = root[part.start].date;
		const end = root[Math.min(part.end, root.length) - 1].date;
		const anchor = mode === "raw" ? `message-${part.start}` : `${mode}-${part.l}-${part.i}`;
		const links =
			mode === "raw"
				? ""
				: part.l === 0
					? `<a href="#message-${part.start}">Open original message →</a>`
					: children(part)
							.map((child) => `<a href="#node-${child.l}-${child.i}">Open ${child.address} →</a>`)
							.join(" · ");
		const label = mode === "raw" ? `Message ${part.start} · ${root[part.start].kind}` : part.address;
		return (
			`<article class="entry" id="${anchor}"><header><strong>${escape(label)}</strong>` +
			`<span>${size.toLocaleString("en-US")} bytes · ${escape(start)}${end !== start ? ` → ${escape(end)}` : ""}</span></header>` +
			`<pre>${escape(text)}</pre><footer>${links}</footer></article>`
		);
	};
	const viewHtml = view.parts.map((part) => entry(part, view.text(part), Buffer.byteLength(view.text(part)), "view")).join("\n");
	const rootHtml = root.map((message) => entry(new Part(0, message.i), message.text, message.size, "raw")).join("\n");
	const nodes = [...view.store.nodes()];
	const levels = [...new Set(nodes.map((node) => node.l))]
		.sort((a, b) => b - a)
		.map((level) => {
			const rows = nodes
				.filter((node) => node.l === level)
				.sort((a, b) => a.i - b.i)
				.map((node) => entry(new Part(node.l, node.i), node.text, node.size, "node"))
				.join("\n");
			return `<h2>Level ${level} · ${2 ** level} messages per node</h2>${rows}`;
		})
		.join("");
	const stats = view.stats();
	const n = (value: number) => value.toLocaleString("en-US");
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)} · Memory</title><style>
${STYLE}
</style></head><body><div class="eyebrow">ORRERY / ${escape(title.toUpperCase())} MEMORY</div><h1>The whole conversation.</h1>
<p>${n(stats.messages)} messages · ${n(stats.nodes)} summaries · ${n(stats.viewBytes)} / ${n(stats.viewBudget)} view bytes. This is a local snapshot; the original messages are unchanged.</p>
<nav aria-label="Memory sections"><button data-tab="view" aria-selected="true">Current view</button><button data-tab="root" aria-selected="false">All messages</button><button data-tab="tree" aria-selected="false">Summary tree</button></nav>
<label for="search">Filter this section</label><input id="search" type="search" placeholder="Search words, paths, decisions…">
<section id="view">${viewHtml || "<p>No messages yet.</p>"}</section>
<section id="root" hidden>${rootHtml}</section>
<section id="tree" hidden>${levels}</section>
<script>
${SCRIPT}
</script></body></html>`;
}
