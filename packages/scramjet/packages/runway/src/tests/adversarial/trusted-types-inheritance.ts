import { htmlTest } from "../../testcommon.ts";

const inherited = htmlTest({
	name: "trusted-types-inherited-default-policy",
	headers: { "Content-Security-Policy": "require-trusted-types-for 'script'" },
	html: `<!doctype html>
<body><script>
runTest(async () => {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  const child = frame.contentWindow;
  const calls = [];
  child.trustedTypes.createPolicy("default", {
    createHTML(value, type, sink) { calls.push([value, type, sink]); return value; },
    createScriptURL(value, type, sink) { calls.push([value, type, sink]); return value; },
    createScript(value, type, sink) { calls.push([value, type, sink]); return value; }
  });
  const div = child.document.createElement("div");
  div.innerHTML = "<b>t</b>";
  const script = child.document.createElement("script");
  script.src = "data:,0";
  child.eval("0");
  assertDeepEqual(calls, [
    ["<b>t</b>", "TrustedHTML", "Element innerHTML"],
    ["data:,0", "TrustedScriptURL", "HTMLScriptElement src"],
    ["0", "TrustedScript", "eval"]
  ], "initial blank frame inherits Trusted Types enforcement");
  assertEqual(div.textContent, "t", "accepted HTML reaches the sink");
  frame.remove();
}, true);
</script>`,
});

function policyTest(name: string, js: string, required = true) {
	return htmlTest({
		name: `trusted-types-${name}`,
		headers: required
			? { "Content-Security-Policy": "require-trusted-types-for 'script'" }
			: {},
		html: `<!doctype html><body><script>runTest(async () => {
      const frame = document.createElement("iframe");
      document.body.appendChild(frame);
      const child = frame.contentWindow;
      const div = child.document.createElement("div");
      ${js}
      frame.remove();
    }, true);</script>`,
	});
}

export default [
	inherited,
	policyTest(
		"direct-eval-and-callback-exceptions",
		`
    const calls = [];
    trustedTypes.createPolicy("default", {
      createScript(value, type, sink) { calls.push([value, type, sink]); return value; }
    });
    const lexical = 42;
    assertEqual(eval("lexical"), 42, "direct eval keeps lexical scope");
    assertEqual(eval(17), 17, "direct eval preserves non-strings");
    assertDeepEqual(calls, [["lexical", "TrustedScript", "eval"]], "direct eval checks once");
    const sentinel = {};
    child.trustedTypes.createPolicy("default", {
      createHTML() { throw sentinel; },
      createScript() { throw sentinel; }
    });
    let htmlError;
    try { div.innerHTML = "input"; } catch (e) { htmlError = e; }
    assertEqual(htmlError, sentinel, "HTML propagates the callback exception");
    let evalError;
    try { child.eval("0"); } catch (e) { evalError = e; }
    assert(evalError instanceof child.EvalError, "eval translates the callback exception");
    const forged = Object.create(child.TrustedScript.prototype);
    assertEqual(child.eval(forged), forged, "eval uses a native brand check");
  `
	),
	policyTest(
		"default-policy-rejection",
		`
    function rejects(fn, Type = child.TypeError) {
      let error;
      try { fn(); } catch (e) { error = e; }
      assert(error instanceof Type, "sink rejects with its realm's TypeError");
    }
    rejects(() => { div.innerHTML = "<b>untrusted</b>"; });
    const script = child.document.createElement("script");
    rejects(() => { script.src = "data:,0"; });
    rejects(() => child.eval("0"), child.EvalError);
    child.trustedTypes.createPolicy("default", { createHTML() { return null; } });
    rejects(() => { div.innerHTML = "<b>untrusted</b>"; });
    assertEqual(div.innerHTML, "", "rejected HTML never mutates the node");
    assertEqual(script.getAttribute("src"), null, "rejected URL never mutates the node");
    rejects(() => child.eval("0"), child.EvalError);
  `
	),
	policyTest(
		"default-policy-transformation",
		`
    const reads = [];
    const calls = [];
    const options = {
      get createHTML() {
        reads.push("createHTML");
        return function(value, type, sink) {
          "use strict";
          assertEqual(this, undefined, "default callback this");
          calls.push([value, type, sink]);
          return "<i>accepted</i>";
        };
      },
      get createScript() { reads.push("createScript"); return () => "21 * 2"; },
      get createScriptURL() { reads.push("createScriptURL"); return undefined; }
    };
    child.trustedTypes.createPolicy("default", options);
    assertDeepEqual(reads, ["createHTML", "createScript", "createScriptURL"], "native dictionary lookup order");
    Object.defineProperty(options, "createHTML", { value() { throw new Error("mutated option"); } });
    div.innerHTML = "<b>input</b>";
    assertEqual(div.innerHTML, "<i>accepted</i>", "policy return value reaches HTML sink");
    let evalError;
    try { child.eval("0"); } catch (e) { evalError = e; }
    assert(evalError instanceof child.EvalError, "eval rejects a transformed source");
    assertDeepEqual(calls, [["<b>input</b>", "TrustedHTML", "Element innerHTML"]], "callback sees original input exactly once");
    assertEqual(reads.length, 3, "options remain snapshotted");
    const object = {};
    assertEqual(child.eval(object), object, "eval preserves non-string arguments");
  `
	),
	policyTest(
		"trusted-value-bypasses-default",
		`
    const trusted = child.trustedTypes.createPolicy("typed", {
      createHTML: value => value,
      createScript: value => value,
      createScriptURL: value => value
    });
    child.trustedTypes.createPolicy("default", {
      createHTML() { throw new Error("unexpected default HTML"); },
      createScript() { throw new Error("unexpected default script"); },
      createScriptURL() { throw new Error("unexpected default URL"); }
    });
    div.innerHTML = trusted.createHTML("<b>trusted</b>");
    assertEqual(div.textContent, "trusted", "TrustedHTML accepted");
    const script = child.document.createElement("script");
    script.src = trusted.createScriptURL("data:,0");
    assertEqual(script.src, "data:,0", "TrustedScriptURL accepted");
    assertEqual(child.eval(trusted.createScript("6 * 7")), 42, "TrustedScript accepted");
  `
	),
	policyTest(
		"default-policy-without-requirement",
		`
    child.trustedTypes.createPolicy("default", {
      createHTML() { throw new Error("unexpected default HTML"); },
      createScript() { throw new Error("unexpected default script"); },
      createScriptURL() { throw new Error("unexpected default URL"); }
    });
    div.innerHTML = "<b>ordinary</b>";
    assertEqual(div.textContent, "ordinary", "plain HTML accepted without a requirement");
    assertEqual(child.eval("6 * 7"), 42, "plain eval accepted without a requirement");
    const script = child.document.createElement("script");
    script.src = "data:,0";
  `,
		false
	),
];
