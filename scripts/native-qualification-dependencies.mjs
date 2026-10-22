// A real offline package-manager workload, not a hand-created snapshot link.
// No registry access, package scripts or model decisions are required.
export const dependencyInstall = [
  'mkdir -p vendor/fixture-bin vendor/fixture-ordinary test',
  `printf '%s' '{"name":"fixture-project","version":"1.0.0","private":true,"scripts":{"build":"fixture-tool && fixture-ordinary","test":"node --test test/*.test.cjs"},"dependencies":{"fixture-bin":"file:vendor/fixture-bin","fixture-ordinary":"file:vendor/fixture-ordinary-1.0.0.tgz"}}' > package.json`,
  `printf '%s' '{"name":"fixture-bin","version":"1.0.0","bin":{"fixture-tool":"cli.js"}}' > vendor/fixture-bin/package.json`,
  `printf '%s\\n' '#!/usr/bin/env node' 'const fs=require("node:fs");fs.mkdirSync("dist",{recursive:true});fs.writeFileSync("dist/local.txt","local build");' > vendor/fixture-bin/cli.js`,
  `printf '%s' '{"name":"fixture-ordinary","version":"1.0.0","bin":{"fixture-ordinary":"cli.js"}}' > vendor/fixture-ordinary/package.json`,
  `printf '%s\\n' '#!/usr/bin/env node' 'require("node:fs").writeFileSync("dist/ordinary.txt","ordinary build");' > vendor/fixture-ordinary/cli.js`,
  `printf '%s' 'const t=require("node:test"),a=require("node:assert/strict"),fs=require("node:fs");t("both restored executables build",()=>{a.equal(fs.readFileSync("dist/local.txt","utf8"),"local build");a.equal(fs.readFileSync("dist/ordinary.txt","utf8"),"ordinary build");});' > test/build.test.cjs`,
  `printf '%s\\n' 'node_modules/' > .gitignore`,
  'npm pack ./vendor/fixture-ordinary --offline --ignore-scripts --pack-destination vendor',
  'npm install --offline --ignore-scripts --no-audit --no-fund',
  'npm run build --offline && npm test --offline',
].join(' && ');
