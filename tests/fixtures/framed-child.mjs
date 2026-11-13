process.stderr.write("ERR_PNPM_FETCH_404\n");
setTimeout(() => {
  process.stdout.write("line 1\nline 2\n");
  process.exitCode = 1;
}, 100);
