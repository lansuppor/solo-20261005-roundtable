const name = 'roundtable';
const args = process.argv.slice(2);

if (args.length > 0 && !(args.length === 1 && ['--help', '-h'].includes(args[0]))) {
  console.error(name + ': unknown arguments; use --help');
  process.exitCode = 2;
} else {
  console.log(name + '\n\nUsage: node app.js [--help]\n\n回合制战役与存档产品。当前仅提供帮助信息。');
}
