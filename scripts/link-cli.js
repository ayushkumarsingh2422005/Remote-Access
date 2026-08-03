const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const cliPkg = path.join(__dirname, '..', 'packages', 'cli');
try {
  execSync(`npm link`, { cwd: cliPkg, stdio: 'ignore' });
  console.log('Linked `ss` CLI globally. You can run: ss start all');
} catch {
  console.log('Run `npm link` inside packages/cli to use the `ss` command globally.');
}
