import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const browserDir = join('dist', 'kb-app', 'browser');
const outFile = join('dist', 'kb-app.js');

// Collect all JS files
const jsFiles = readdirSync(browserDir)
  .filter(f => f.endsWith('.js'))
  .sort((a, b) => {
    // polyfills first, then main chunks
    if (a.includes('polyfills')) return -1;
    if (b.includes('polyfills')) return 1;
    return a.localeCompare(b);
  });

// Collect all CSS files
const cssFiles = readdirSync(browserDir).filter(f => f.endsWith('.css'));

let output = '';

// Inject CSS as <style> element
if (cssFiles.length > 0) {
  const allCss = cssFiles
    .map(f => readFileSync(join(browserDir, f), 'utf-8'))
    .join('\n');
  const escaped = allCss.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
  output += `(function(){var s=document.createElement("style");s.textContent=\`${escaped}\`;document.head.appendChild(s)})();\n`;
}

// Concatenate JS chunks
for (const f of jsFiles) {
  output += readFileSync(join(browserDir, f), 'utf-8') + '\n';
}

mkdirSync('dist', { recursive: true });
writeFileSync(outFile, output);
console.log(`Built ${outFile} (${(output.length / 1024).toFixed(1)} KB) from ${jsFiles.length} JS + ${cssFiles.length} CSS files`);
