/**
 * Draws the Orrery badge's solar system (assets/orrery.svg) as the small braille logo (the TUI header's top-left corner,
 * the Orrery mod's startup band in Claude Code), and writes claude-plugin/hooks/logo.ts, the one copy of its data. Dev
 * time only: `node --disable-warning=ExperimentalWarning scripts/orrery-art.ts`.
 *
 * It redraws the solar system from the SVG's own shapes (two of the orbits, the sun's core, three planets) on a grid
 * of dots; the rim, the disc, the arm, the sun's rays, the stars, the glows and the rim's ticks are left out. Each
 * braille cell takes the colour of its strongest feature: a planet's own colour, then the sun's orange, then gold.
 * Gold is kept out of the sun's and the planets' cells, so every cell has one colour.
 *
 * `--preview out.png` also writes a picture of it, coloured as a terminal shows it (needs `magick`).
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SVG = join(ROOT, "assets", "orrery.svg");
const OUT = join(ROOT, "claude-plugin", "hooks", "logo.ts");

/** A dot's height over its width on screen: a cell is 2 × 4 dots and about 1:2.1, so a dot is 1:1.05. */
const DOT_ASPECT = 1.05;
/** Where the sun is in the SVG; the logo is centred on it. */
const CENTRE = 256;

/** Feature kinds, strongest first: a cell shows the colour of the strongest one among its dots. */
type Kind = "planet" | "core" | "orbit";
const STRENGTH: Record<Kind, number> = { planet: 3, core: 2, orbit: 1 };

/** Colours as the terminal draws them (hex). Planets keep their own fill. */
const GOLD_ORBIT = "#b08d52";
const SUN_CORE = "#e98a66";

/**
 * The logo: the smallest size that still draws both orbits cleanly (the solar system is about twice as wide as it is
 * tall). It keeps two orbits (by index from the innermost) and three planets (by fill), and gives the sun and the
 * planets a smallest radius in dots, so they read at this size.
 */
const LOGO = { cols: 18, rows: 5, orbits: [1, 3], planets: ["#ffe08a", "#d6e4ff", "#c3d6ff"], sun: 2, planet: 1 } as const;

interface Dot {
	kind: Kind;
	color: string;
}

interface Orbit {
	readonly cx: number;
	readonly cy: number;
	readonly rx: number;
	readonly ry: number;
	readonly angle: number;
}

interface Planet {
	readonly cx: number;
	readonly cy: number;
	readonly r: number;
	readonly color: string;
}

const num = (s: string | undefined): number => {
	const n = Number(s);
	if (!Number.isFinite(n)) throw new Error(`orrery-art: not a number in the SVG: ${s}`);
	return n;
};
const attr = (tag: string, name: string): string | undefined => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
const tags = (svg: string, name: string): string[] => svg.match(new RegExp(`<${name}\\b[^>]*>`, "g")) ?? [];
const rotation = (tag: string): number => num(/rotate\(([-\d.]+)/.exec(attr(tag, "transform") ?? "rotate(0")?.[1]);
const radians = (degrees: number) => (degrees * Math.PI) / 180;

/** The solar system's shapes, read from the SVG (the rim, the disc, the arm, the rays, the stars and the glows are not read). */
function readShapes(svg: string) {
	const orbits: Orbit[] = tags(svg, "ellipse")
		.map((t) => ({ cx: num(attr(t, "cx")), cy: num(attr(t, "cy")), rx: num(attr(t, "rx")), ry: num(attr(t, "ry")), angle: rotation(t) }))
		.sort((a, b) => a.rx - b.rx);
	// Solid circles (no opacity): the sun's core at the centre, and the planets. Stars and glows all carry an opacity.
	const solid: Planet[] = tags(svg, "circle")
		.filter((t) => attr(t, "opacity") === undefined && attr(t, "fill")?.startsWith("#"))
		.map((t) => ({ cx: num(attr(t, "cx")), cy: num(attr(t, "cy")), r: num(attr(t, "r")), color: attr(t, "fill") ?? "" }));
	const core = solid.find((c) => c.color === SUN_CORE);
	if (core === undefined) throw new Error(`orrery-art: no sun core (fill ${SUN_CORE}) in the SVG`);
	const planets = solid.filter((c) => c !== core);
	return { orbits, core, planets };
}
type Shapes = ReturnType<typeof readShapes>;

/** Which orbit a planet sits on: the one whose ellipse passes nearest its centre. */
function orbitOf(p: Planet, orbits: readonly Orbit[]): number {
	const reach = orbits.map((o) => {
		const a = radians(-o.angle);
		const dx = p.cx - o.cx;
		const dy = p.cy - o.cy;
		const u = dx * Math.cos(a) - dy * Math.sin(a);
		const v = dx * Math.sin(a) + dy * Math.cos(a);
		return Math.abs(Math.hypot(u / o.rx, v / o.ry) - 1);
	});
	return reach.indexOf(Math.min(...reach));
}

/** A tilted ellipse's half width and half height. */
function extent(o: Orbit): [number, number] {
	const a = radians(o.angle);
	return [Math.hypot(o.rx * Math.cos(a), o.ry * Math.sin(a)), Math.hypot(o.rx * Math.sin(a), o.ry * Math.cos(a))];
}

/** Draws what the logo keeps on its grid of dots, scaled so it fills the width (or the height) with a dot to spare. */
function draw(shapes: Shapes): (Dot | undefined)[][] {
	const size = LOGO;
	const dotsX = size.cols * 2;
	const dotsY = size.rows * 4;
	const kept: readonly number[] = size.orbits;
	const keptPlanets: readonly string[] = size.planets;
	const orbits = kept.map((i) => shapes.orbits[i]);
	const planets = shapes.planets.filter((p) => kept.includes(orbitOf(p, shapes.orbits)) && keptPlanets.includes(p.color));
	if (planets.length !== keptPlanets.length) throw new Error("orrery-art: a kept planet is not on a kept orbit");
	// The box, centred on the sun, that holds the kept orbits and planets.
	let halfW = 0;
	let halfH = 0;
	for (const o of orbits) {
		const [w, h] = extent(o);
		halfW = Math.max(halfW, Math.abs(o.cx - CENTRE) + w);
		halfH = Math.max(halfH, Math.abs(o.cy - CENTRE) + h);
	}
	for (const p of planets) {
		halfW = Math.max(halfW, Math.abs(p.cx - CENTRE) + p.r);
		halfH = Math.max(halfH, Math.abs(p.cy - CENTRE) + p.r);
	}
	/** SVG units per dot, across and down. */
	const pitchX = Math.max((2 * halfW) / (dotsX - 2), (2 * halfH) / ((dotsY - 2) * DOT_ASPECT));
	const pitchY = pitchX * DOT_ASPECT;
	const left = CENTRE - (dotsX / 2) * pitchX;
	const top = CENTRE - (dotsY / 2) * pitchY;

	const grid: (Dot | undefined)[][] = Array.from({ length: dotsY }, () => Array.from({ length: dotsX }, () => undefined));
	const put = (gx: number, gy: number, kind: Kind, color: string) => {
		if (gx < 0 || gy < 0 || gx >= dotsX || gy >= dotsY) return;
		const was = grid[gy][gx];
		if (was === undefined || STRENGTH[kind] > STRENGTH[was.kind]) grid[gy][gx] = { kind, color };
	};
	/** A point in SVG units lights the dot it falls in. */
	const plot = (x: number, y: number, kind: Kind, color: string) => put(Math.floor((x - left) / pitchX), Math.floor((y - top) / pitchY), kind, color);
	/** A closed or open curve, walked in steps far smaller than a dot, so the line has no gaps. */
	const trace = (point: (t: number) => [number, number], length: number, kind: Kind, color: string) => {
		const steps = Math.ceil((length / Math.min(pitchX, pitchY)) * 8);
		for (let i = 0; i <= steps; i++) {
			const [x, y] = point(i / steps);
			plot(x, y, kind, color);
		}
	};
	/** A filled shape: a dot is lit when enough of it is inside (`inside` in SVG units). */
	const fill = (inside: (x: number, y: number) => boolean, kind: Kind, color: string, cover: number) => {
		const n = 4;
		for (let gy = 0; gy < dotsY; gy++) {
			for (let gx = 0; gx < dotsX; gx++) {
				let hits = 0;
				for (let sy = 0; sy < n; sy++) for (let sx = 0; sx < n; sx++) if (inside(left + (gx + (sx + 0.5) / n) * pitchX, top + (gy + (sy + 0.5) / n) * pitchY)) hits++;
				if (hits / (n * n) >= cover) put(gx, gy, kind, color);
			}
		}
	};

	// The orbits: tilted ellipses, one dot thick.
	for (const o of orbits) {
		const a = radians(o.angle);
		trace(
			(t) => {
				const ex = o.rx * Math.cos(t * 2 * Math.PI);
				const ey = o.ry * Math.sin(t * 2 * Math.PI);
				return [o.cx + ex * Math.cos(a) - ey * Math.sin(a), o.cy + ex * Math.sin(a) + ey * Math.cos(a)];
			},
			2 * Math.PI * o.rx,
			"orbit",
			GOLD_ORBIT,
		);
	}
	const { core } = shapes;
	// The sun's core (at least `size.sun` dots across its radius).
	const coreR = Math.max(core.r, size.sun * pitchX);
	fill((x, y) => Math.hypot(x - core.cx, y - core.cy) <= coreR, "core", SUN_CORE, 0.5);
	// The planets: each at least `size.planet` dots in radius, so it reads as a bead on its orbit.
	for (const p of planets) {
		const r = Math.max(p.r, size.planet * pitchX);
		fill((x, y) => Math.hypot(x - p.cx, y - p.cy) <= r, "planet", p.color, 0.25);
		plot(p.cx, p.cy, "planet", p.color);
	}
	// A one-dot gap between the gold lines and what sits on them (the sun, the planets), as the badge's glows do, so
	// each reads as a bead; gold also leaves their cells.
	const solid = (gx: number, gy: number) => {
		const dot = grid[gy]?.[gx];
		return dot !== undefined && (dot.kind === "core" || dot.kind === "planet");
	};
	const solidCell = (gx: number, gy: number) => {
		const x0 = gx - (gx % 2);
		const y0 = gy - (gy % 4);
		for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 2; dx++) if (solid(x0 + dx, y0 + dy)) return true;
		return false;
	};
	const gaps: [number, number][] = [];
	for (let gy = 0; gy < dotsY; gy++) {
		for (let gx = 0; gx < dotsX; gx++) {
			if (grid[gy][gx] === undefined || solid(gx, gy)) continue;
			let near = solidCell(gx, gy);
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) near ||= solid(gx + dx, gy + dy);
			if (near) gaps.push([gx, gy]);
		}
	}
	for (const [gx, gy] of gaps) grid[gy][gx] = undefined;
	return grid;
}

/** Braille bits for the dot at (dx, dy) in a cell: 1,2,3,7 down the left column, 4,5,6,8 down the right. */
const BITS = [
	[0x01, 0x08],
	[0x02, 0x10],
	[0x04, 0x20],
	[0x40, 0x80],
];

interface Cell {
	char: string;
	color?: string;
}

/** The grid as braille cells; a blank cell is a space. */
function cells(grid: (Dot | undefined)[][]): Cell[][] {
	const out: Cell[][] = [];
	for (let row = 0; row < grid.length / 4; row++) {
		const line: Cell[] = [];
		for (let col = 0; col < grid[0].length / 2; col++) {
			let bits = 0;
			let best: Dot | undefined;
			for (let dy = 0; dy < 4; dy++) {
				for (let dx = 0; dx < 2; dx++) {
					const dot = grid[row * 4 + dy][col * 2 + dx];
					if (dot === undefined) continue;
					bits |= BITS[dy][dx];
					if (best === undefined || STRENGTH[dot.kind] > STRENGTH[best.kind]) best = dot;
				}
			}
			line.push(bits === 0 ? { char: " " } : { char: String.fromCodePoint(0x2800 + bits), color: best?.color });
		}
		out.push(line);
	}
	return out;
}

/** Runs of cells with the same colour. */
function segments(line: readonly Cell[]): { text: string; color?: string }[] {
	const out: { text: string; color?: string }[] = [];
	for (const cell of line) {
		const last = out.at(-1);
		if (last !== undefined && last.color === cell.color) last.text += cell.char;
		else out.push(cell.color === undefined ? { text: cell.char } : { text: cell.char, color: cell.color });
	}
	return out;
}

function table(rows: Cell[][]): string {
	return rows
		.map((line) => {
			const parts = segments(line).map((s) => (s.color === undefined ? `{ text: ${JSON.stringify(s.text)} }` : `{ text: ${JSON.stringify(s.text)}, color: ${JSON.stringify(s.color)} }`));
			return `\t[${parts.join(", ")}],`;
		})
		.join("\n");
}

function source(logo: Cell[][]): string {
	return `/**
 * The Orrery badge's solar system as the small braille logo: the TUI header's top-left corner (src/tui/art.ts) and the
 * Orrery mod's startup band in Claude Code (mod.ts) both draw it. It imports nothing, since Claude Code loads this file
 * into the mod's own environment. Generated by scripts/orrery-art.ts from assets/orrery.svg: run it again rather than
 * editing the logo by hand.
 */

/** A run of cells in one colour (hex); no colour for blank cells. */
export interface ArtSegment {
	readonly text: string;
	readonly color?: string;
}

/** The small logo's size in terminal cells. */
export const LOGO_WIDTH = ${LOGO.cols};
export const LOGO_HEIGHT = ${LOGO.rows};

/** The small logo, one line per row, each exactly LOGO_WIDTH cells. */
export const LOGO: readonly (readonly ArtSegment[])[] = [
${table(logo)}
];
`;
}

/** A picture of the logo as a terminal shows it: 10 × 21 pixel cells, each dot in its cell's colour, on navy. */
function preview(rows: Cell[][], path: string): void {
	const cw = 10;
	const ch = 21;
	const w = rows[0].length * cw;
	const h = rows.length * ch;
	const pixels = Buffer.alloc(w * h * 3);
	for (let i = 0; i < w * h; i++) pixels.set([0x12, 0x18, 0x29], i * 3);
	rows.forEach((line, row) => {
		line.forEach((cell, col) => {
			if (cell.color === undefined) return;
			const bits = (cell.char.codePointAt(0) ?? 0x2800) - 0x2800;
			const rgb = [1, 3, 5].map((k) => Number.parseInt((cell.color ?? "#ffffff").slice(k, k + 2), 16));
			for (let dy = 0; dy < 4; dy++) {
				for (let dx = 0; dx < 2; dx++) {
					if ((bits & BITS[dy][dx]) === 0) continue;
					const x0 = col * cw + dx * (cw / 2);
					const y0 = row * ch + dy * (ch / 4);
					for (let py = Math.round(y0 + 1); py < Math.round(y0 + ch / 4 - 1); py++) {
						for (let px = Math.round(x0 + 1); px < Math.round(x0 + cw / 2 - 1); px++) pixels.set(rgb, (py * w + px) * 3);
					}
				}
			}
		});
	});
	const ppm = Buffer.concat([Buffer.from(`P6 ${w} ${h} 255\n`), pixels]);
	execFileSync("magick", ["ppm:-", path], { input: ppm });
}

const logo = cells(draw(readShapes(readFileSync(SVG, "utf8"))));
writeFileSync(OUT, source(logo));
console.log(logo.map((line) => line.map((c) => c.char).join("")).join("\n"));
const at = process.argv.indexOf("--preview");
if (at !== -1 && process.argv[at + 1] !== undefined) preview(logo, resolve(process.argv[at + 1]));
