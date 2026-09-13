//! PDF inspection and text extraction powered by pdf-inspector.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::task;

/// Extracted text and metadata from a PDF document.
#[napi(object)]
pub struct PdfExtractResult {
	/// Extracted text (markdown-flavored when structure detection produced it).
	pub text:                String,
	/// Number of pages.
	pub page_count:          u32,
	/// Detected PDF type (e.g. `TextBased`, `Scanned`).
	pub pdf_type:            String,
	/// Document title from PDF metadata, when available.
	pub title:               Option<String>,
	/// True when broken font encodings were detected (garbled text).
	pub has_encoding_issues: bool,
}

/// Extract text and metadata from a PDF document given as bytes.
#[napi]
pub fn extract_pdf_text(bytes: Uint8Array) -> task::Promise<PdfExtractResult> {
	let bytes = bytes.as_ref().to_vec();
	task::blocking("pdf.extract", (), move |_| extract_pdf_text_inner(&bytes))
}

fn extract_pdf_text_inner(bytes: &[u8]) -> Result<PdfExtractResult> {
	let result = pdf_inspector::process_pdf_mem(bytes)
		.map_err(|err| Error::from_reason(format!("Failed to extract PDF text: {err}")))?;
	Ok(PdfExtractResult {
		text:                result.markdown.unwrap_or_default(),
		page_count:          result.page_count,
		pdf_type:            format!("{:?}", result.pdf_type),
		title:               result.title,
		has_encoding_issues: result.has_encoding_issues,
	})
}
