// Ambient declaration for `.md` files imported as text.
// The root `bunfig.toml` registers `.md` as the `text` loader, but
// tsgo does not see bunfig.toml. The `with { type: "text" }` import
// attribute on the consumer side requires this declaration.
declare module "*.md" {
	const content: string;
	export default content;
}
