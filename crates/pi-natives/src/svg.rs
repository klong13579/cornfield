//! SVG rasterization powered by resvg.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::task;

/// Rasterize an SVG document to PNG bytes at its intrinsic size.
///
/// Font loading is left to the calling layer: this primitive parses and
/// renders vector content, so text glyphs only appear once a font database is
/// wired in.
#[napi]
pub fn rasterize_svg(bytes: Uint8Array) -> task::Promise<Vec<u8>> {
	let bytes = bytes.as_ref().to_vec();
	task::blocking("svg.rasterize", (), move |_| rasterize_svg_inner(&bytes))
}

fn rasterize_svg_inner(bytes: &[u8]) -> Result<Vec<u8>> {
	use resvg::{tiny_skia, usvg};

	let tree = usvg::Tree::from_data(bytes, &usvg::Options::default())
		.map_err(|err| Error::from_reason(format!("Failed to parse SVG: {err}")))?;
	let size = tree.size().to_int_size();
	let mut pixmap = tiny_skia::Pixmap::new(size.width(), size.height())
		.ok_or_else(|| Error::from_reason("SVG has an invalid (empty) size"))?;
	resvg::render(&tree, tiny_skia::Transform::default(), &mut pixmap.as_mut());
	pixmap
		.encode_png()
		.map_err(|err| Error::from_reason(format!("Failed to encode PNG: {err}")))
}
