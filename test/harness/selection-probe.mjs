// Selection probe: prints the search outcome for a spread of queries against a
// fixed 6-tool catalog, so a change to scoring/abstention can be eyeballed
// without reading the test diff.
//
// Expected shape: clear queries HIT with high confidence; off-topic queries
// ABSTAIN. Run from the dock/ root:  node test/harness/selection-probe.mjs
import { buildIndex, search } from "../../src/select.js";
const cat = [
  { qname:"files__read_file", server:"files", tool:"read_file", description:"Read a file from disk and return its contents.", inputSchema:null },
  { qname:"files__write_file", server:"files", tool:"write_file", description:"Write text content to a file, overwriting if present.", inputSchema:null },
  { qname:"files__list_dir", server:"files", tool:"list_dir", description:"List the entries in a directory.", inputSchema:null },
  { qname:"net__http_get", server:"net", tool:"http_get", description:"Perform an HTTP GET request and return the response body.", inputSchema:null },
  { qname:"net__send_email", server:"net", tool:"send_email", description:"Send an email message to a recipient address.", inputSchema:null },
  { qname:"git__commit", server:"git", tool:"commit", description:"Create a commit from staged changes in a git repository.", inputSchema:null },
];
const idx = buildIndex(cat);
for (const q of ["read a file","read contents from disk","write content to file","frobnicate the widget","delete everything"]) {
  const r = search(idx, q);
  console.log((q+"                            ").slice(0,26),
    r.abstained ? `ABSTAIN (${r.reason})`.slice(0,60) : `HIT ${r.results[0].qname} conf=${r.confidence}`);
}
