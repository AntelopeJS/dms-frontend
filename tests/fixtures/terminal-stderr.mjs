// Preloaded with --import: stderr reads as a terminal, as in an interactive
// run, without a pseudo-terminal to drive.
Object.defineProperty(process.stderr, "isTTY", { value: true });
