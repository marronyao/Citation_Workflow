const fs = require('fs');
const styles = require('./node_modules/@citation-js/plugin-csl/lib/styles.json');
let out = '# Third-party notices\n\nCitation rendering uses Citation.js and citeproc-js by Frank Bennett. citeproc-js license text: [vendor/licenses/citeproc-LICENSE.txt](vendor/licenses/citeproc-LICENSE.txt). Source: https://github.com/Juris-M/citeproc-js\n\n';
for (const [path, pkg] of Object.entries(require('./package-lock.json').packages)) {
  if (path && !path.includes('@esbuild/')) out += `- ${path}: ${pkg.version}; ${pkg.license}\n`;
}
out += '\nCSL styles and locales: https://github.com/citation-style-language/styles (CC BY-SA 3.0). Individual author credits and license links follow.\n';
for (const [key, style] of Object.entries(styles)) out += '\n## '+key+'\n\n```xml\n'+(style.match(/<info>[\s\S]*?<\/info>/)||[''])[0]+'\n```\n';
fs.mkdirSync('vendor/licenses',{recursive:true});
fs.copyFileSync('node_modules/citeproc/LICENSE','vendor/licenses/citeproc-LICENSE.txt');
fs.writeFileSync('THIRD_PARTY_NOTICES.md',out);
