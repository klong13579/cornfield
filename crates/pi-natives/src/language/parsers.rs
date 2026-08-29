//! Tree-sitter parser functions for all supported languages.

use ast_grep_core::tree_sitter::TSLanguage;

pub fn language_bash() -> TSLanguage {
	tree_sitter_bash::LANGUAGE.into()
}
pub fn language_c() -> TSLanguage {
	tree_sitter_c::LANGUAGE.into()
}
pub fn language_cpp() -> TSLanguage {
	tree_sitter_cpp::LANGUAGE.into()
}
pub fn language_css() -> TSLanguage {
	tree_sitter_css::LANGUAGE.into()
}
pub fn language_diff() -> TSLanguage {
	tree_sitter_diff::LANGUAGE.into()
}
pub fn language_dockerfile() -> TSLanguage {
	tree_sitter_dockerfile::language()
}
pub fn language_go() -> TSLanguage {
	tree_sitter_go::LANGUAGE.into()
}
pub fn language_html() -> TSLanguage {
	tree_sitter_html::LANGUAGE.into()
}
pub fn language_java() -> TSLanguage {
	tree_sitter_java::LANGUAGE.into()
}
pub fn language_javascript() -> TSLanguage {
	tree_sitter_javascript::LANGUAGE.into()
}
pub fn language_json() -> TSLanguage {
	tree_sitter_json::LANGUAGE.into()
}
pub fn language_lua() -> TSLanguage {
	tree_sitter_lua::LANGUAGE.into()
}
pub fn language_markdown() -> TSLanguage {
	tree_sitter_md::LANGUAGE.into()
}
pub fn language_php() -> TSLanguage {
	tree_sitter_php::LANGUAGE_PHP_ONLY.into()
}
pub fn language_python() -> TSLanguage {
	tree_sitter_python::LANGUAGE.into()
}
pub fn language_regex() -> TSLanguage {
	tree_sitter_regex::LANGUAGE.into()
}
pub fn language_ruby() -> TSLanguage {
	tree_sitter_ruby::LANGUAGE.into()
}
pub fn language_rust() -> TSLanguage {
	tree_sitter_rust::LANGUAGE.into()
}
pub fn language_sql() -> TSLanguage {
	tree_sitter_sql::LANGUAGE.into()
}
pub fn language_toml() -> TSLanguage {
	tree_sitter_toml_ng::LANGUAGE.into()
}
pub fn language_tsx() -> TSLanguage {
	tree_sitter_typescript::LANGUAGE_TSX.into()
}
pub fn language_typescript() -> TSLanguage {
	tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()
}
pub fn language_yaml() -> TSLanguage {
	tree_sitter_yaml::LANGUAGE.into()
}
