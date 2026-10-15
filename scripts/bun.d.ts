/** The little of Bun that scripts/*.ts use when they run on Bun. */
declare const Bun: { readonly version: string };
interface ImportMeta {
	readonly main: boolean;
}
