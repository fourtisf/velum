// Checks every post in x-posts.md, or the file given as the first argument (the text between <!-- post --> and <!-- /post -->) against X's 280 limit, counted
// the way X counts: a URL ([link]) is 23 characters; code points in X's light ranges weigh 1, everything else
// (emoji, arrows, most symbols, CJK) weighs 2. Run: node design/marketing/check-x-posts.cjs [file.md]
const { readFileSync } = require('node:fs');
const path = require('node:path');

const LIGHT = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247],
];
const weight = (cp) => (LIGHT.some(([a, b]) => cp >= a && cp <= b) ? 1 : 2);

function xLength(text) {
  const t = text.replace(/\[link\]/g, '\u0000'.repeat(1));
  let n = 0;
  for (const ch of t.normalize('NFC')) {
    if (ch === '\u0000') n += 23;
    else if (ch === '️' || ch === '‍') continue; // variation selectors and joiners ride on the emoji
    else n += weight(ch.codePointAt(0));
  }
  return n;
}

const file = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, 'x-posts.md');
const md = readFileSync(file, 'utf8');
const posts = [...md.matchAll(/<!-- post -->\n([\s\S]*?)\n<!-- \/post -->/g)].map((m) => m[1]);
let bad = 0;
for (const p of posts) {
  const n = xLength(p);
  const first = p.split('\n')[0].slice(0, 60);
  console.log(`${n > 280 ? 'OVER' : 'ok  '} ${String(n).padStart(3)}  ${first}`);
  if (n > 280) bad++;
}
console.log(`\n${posts.length} posts, ${bad} over 280`);
process.exit(bad ? 1 : 0);
