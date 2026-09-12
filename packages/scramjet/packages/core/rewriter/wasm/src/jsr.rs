use std::error::Error;

use js::{
	RewriteResult, Rewriter,
	cfg::{Config, Flags, UrlRewriter},
};
use js_sys::{Function, Object, Uint8Array, encode_uri_component};
use oxc::allocator::StringBuilder;
use wasm_bindgen::{JsCast, JsValue, prelude::wasm_bindgen};
use web_sys::Url;

use crate::{
	error::{Result, RewriterError},
	 get_obj, get_str, set_obj,
};

// A tag has to be UNIQUE, not unpredictable: it only keys
// `client.box.sourcemaps`, and it is emitted inside a `/*scramtag n tag*/`
// comment. So it is a counter, not randomness.
//
// It used to be a random-uuid variant, which called `crypto.getRandomValues`
// ELEVEN times per tag. Under an oracle with a deterministic PRNG that is not
// merely wasteful, it is disqualifying: the keystream counter is shared by
// every realm on a thread, so 2585 draws from the rewriter (measured on
// rateyourmusic against the guest page's 6) shift every value the guest
// afterwards sees. Cloudflare's Turnstile derives its widget id from one of
// those, puts it in a URL and routes postMessages on it, so the sandbox and
// the recording could not agree on it and the widget hung.
//
// The prefix is a 32-bit FNV-1a of the context's own URL. A bare counter would
// do for one rewriter, but the window and the service worker both mint tags
// into the same client box, and they would collide from zero.
#[wasm_bindgen(inline_js = r#"
let scramtagCounter = 0;
let scramtagPrefix = "";
export function scramtag() {
    if (scramtagPrefix === "") {
        let h = 0x811c9dc5;
        const s = "" + ((typeof self !== "undefined" && self.location) ? self.location.href : "");
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 0x01000193) >>> 0;
        }
        scramtagPrefix = h.toString(36) + "x";
    }
    return scramtagPrefix + (scramtagCounter++).toString(36);
}
"#)]
extern "C" {
	pub fn scramtag() -> std::string::String;
}

#[wasm_bindgen(typescript_custom_section)]
const REWRITER_OUTPUT: &'static str = r#"
export type JsRewriterOutput = {
	js: Uint8Array,
	map: Uint8Array,
	scramtag: string,
	errors: string[],
};
"#;

#[wasm_bindgen]
extern "C" {
	#[wasm_bindgen(typescript_type = "JsRewriterOutput")]
	pub type JsRewriterOutput;
}


pub struct WasmUrlRewriter(Function);

impl UrlRewriter for WasmUrlRewriter {
	fn rewrite(
		&self,
		_cfg: &Config,
		flags: &Flags,
		url: &str,
		builder: &mut StringBuilder,
		module: bool,
	) -> std::result::Result<(), Box<dyn Error + Sync + Send>> {
		let url = Url::new_with_base(url, &flags.base)
			.map_err(RewriterError::from)?
			.to_string();

		let mut rewritten = self
			.0
			.call1(&JsValue::NULL, &url.into())
			.map_err(RewriterError::from)?
			.as_string()
			.ok_or_else(|| RewriterError::not_str("url rewriter output"))?;

		if module {
			// TODO: keep this in sync with QP.isModule or find a way to make this use the real rewriteUrl function
			let origin = Url::new(&flags.base).map_err(RewriterError::from)?.origin();
			let encoded_origin: String = encode_uri_component(&origin).into();
			rewritten.push_str("?%24module=module&%24io=");
			rewritten.push_str(&encoded_origin);
		}

		builder.push_str(&rewritten);

		Ok(())
	}
}

pub type JsRewriter = Rewriter;

pub fn create_js() -> Result<JsRewriter> {
	Ok(Rewriter::new())
}

pub fn get_url_rewriter(func: Object) -> Result<WasmUrlRewriter> {
	Ok(WasmUrlRewriter(
		func
			.dyn_into()
			.map_err(|_| RewriterError::not_fn("scramjet.codec.encode"))?,
	))
}

pub fn create_js_output(out: RewriteResult, url: String, src: String) -> Result<JsRewriterOutput> {
	let obj = Object::new();
	set_obj(&obj, "js", &Uint8Array::from(out.js.as_slice()).into())?;
	set_obj(
		&obj,
		"map",
		&Uint8Array::from(out.sourcemap.as_slice()).into(),
	)?;
	set_obj(&obj, "scramtag", &out.flags.sourcetag.into())?;

	#[cfg(feature = "debug")]
	{
		let src = std::sync::Arc::new(
			oxc::diagnostics::NamedSource::new(url, src).with_language("javascript"),
		);
		let errs: Vec<_> = out
			.errors
			.into_iter()
			.map(|x| format!("{}", x.with_source_code(src.clone())))
			.collect();
		set_obj(&obj, "errors", &errs.into())?;
	}
	#[cfg(not(feature = "debug"))]
	{
		let _ = (url, src);
		set_obj(&obj, "errors", &js_sys::Array::new())?;
	}

	Ok(JsRewriterOutput::from(JsValue::from(obj)))
}
