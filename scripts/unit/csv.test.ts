// export.ts imports ../components/ui (React). Test the two pure helpers by
// extracting their source text, so this runs under plain Node.
import { readFileSync } from 'node:fs';
const src = readFileSync(process.argv[2] ?? new URL('../../src/lib/export.ts', import.meta.url), 'utf8');
const grab = (name: string) => {
  const start = src.indexOf(`export function ${name}`);
  let depth = 0, i = src.indexOf('{', src.indexOf(')', start));
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1).replace('export ', '').replace(/: [a-z| ]+(\[\])?(?=[,)])/g, '').replace(/\): string/, ')');
  }
  throw new Error(name);
};
const { paiseToCsv, csvCell } = new Function(`${grab('paiseToCsv')}\n${grab('csvCell')}\nreturn { paiseToCsv, csvCell };`)();

let fail = 0;
const eq = (n: string, g: unknown, w: unknown) => { if (g !== w) { fail++; console.log(`FAIL ${n}: got ${g} want ${w}`); } };

eq('1010', paiseToCsv(1010), '10.10');
eq('5', paiseToCsv(5), '0.05');
eq('neg', paiseToCsv(-25050), '-250.50');
eq('zero', paiseToCsv(0), '0.00');
eq('big', paiseToCsv(500000000), '5000000.00');
eq('string bigint', paiseToCsv('123456789012'), '1234567890.12');
eq('formula =', csvCell('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`);
eq('formula +', csvCell('+91 98765'), `"'+91 98765"`);
eq('formula @', csvCell('@SUM(A1)'), `"'@SUM(A1)"`);
eq('formula -text', csvCell('-cmd'), `"'-cmd"`);
eq('neg amount untouched', csvCell('-250.50'), '"-250.50"');
eq('number untouched', csvCell(-3), '"-3"');
eq('hash kept', csvCell('Flat #4'), '"Flat #4"');
eq('quote escaped', csvCell('Ravi "RK" Kumar'), '"Ravi ""RK"" Kumar"');
eq('null', csvCell(null), '""');

console.log(fail ? `${fail} FAILED` : 'ALL PASSED');
process.exit(fail ? 1 : 0);
