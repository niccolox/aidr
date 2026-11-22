import {execFileSync} from 'node:child_process';
const files=JSON.parse(execFileSync('npm',['pack','--dry-run','--json'],{encoding:'utf8'}))[0].files.map(f=>f.path).sort();
const ok=files.every(p=>/^(bin|lib)\//.test(p)||['README.md','LICENSE','package.json'].includes(p));
if(!ok){console.error('Unexpected files in the package: '+files.join(' '));process.exit(1);}
console.log(files.length+' files: '+files.join(' '));
