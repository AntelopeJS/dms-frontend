import boxen, { type Options as BoxenOptions } from "boxen";
import chalk from "chalk";
import figlet from "figlet";

const clearLine = () => process.stdout.write("\r\x1b[K");
const spinnerChars = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const SPINNER_INTERVAL_MS = 80;

/**
 * Check if output is a terminal (TTY)
 */
function isTerminalOutput(): boolean {
  return process.stdout.isTTY ?? false;
}

/**
 * Creates and manages a simple spinner with customizable text and success/error messages.
 */
export class Spinner {
  private text: string;
  private isRunning = false;
  private interval?: NodeJS.Timeout;
  private currentCharIndex = 0;
  private isTerminal = isTerminalOutput();

  constructor(text: string) {
    this.text = text;
  }

  async start(text?: string): Promise<Spinner> {
    if (text) {
      this.text = text;
    }

    if (this.isRunning) {
      return this;
    }

    this.isRunning = true;
    this.currentCharIndex = 0;

    if (!this.isTerminal) {
      console.log(`  ${this.text}`);
      return this;
    }

    this.interval = setInterval(() => {
      if (this.isRunning) {
        const spinnerChar = spinnerChars[this.currentCharIndex];
        process.stdout.write(`\r${chalk.cyan(spinnerChar)} ${this.text}`);
        this.currentCharIndex =
          (this.currentCharIndex + 1) % spinnerChars.length;
      }
    }, SPINNER_INTERVAL_MS);

    return this;
  }

  update(text: string): Spinner {
    this.text = text;
    return this;
  }

  log(stream: NodeJS.WriteStream, message: string): Spinner {
    if (this.isRunning && this.isTerminal) {
      clearLine();
      stream.write(`${message}\n`);
      const spinnerChar = spinnerChars[this.currentCharIndex];
      process.stdout.write(`${chalk.cyan(spinnerChar)} ${this.text}`);
    } else {
      stream.write(`${message}\n`);
    }
    return this;
  }

  async succeed(text?: string): Promise<void> {
    if (!this.isRunning) return;

    await this.stop();
    const message = text || this.text;

    if (this.isTerminal) {
      process.stdout.write(`\r${chalk.bold.green("✓")} ${message}\n`);
    } else {
      console.log(`✓ ${message}`);
    }
  }

  async fail(text?: string): Promise<void> {
    if (!this.isRunning) return;

    await this.stop();
    const message = text || this.text;

    if (this.isTerminal) {
      process.stdout.write(`\r${chalk.bold.red("✗")} ${chalk.red(message)}\n`);
    } else {
      console.log(`✗ ${message}`);
    }
  }

  async info(text?: string): Promise<void> {
    if (!this.isRunning) return;

    await this.stop();
    const message = text || this.text;

    if (this.isTerminal) {
      process.stdout.write(`\r${chalk.bold.blue("ℹ")} ${message}\n`);
    } else {
      console.log(`ℹ ${message}`);
    }
  }

  async warn(text?: string): Promise<void> {
    if (!this.isRunning) return;

    await this.stop();
    const message = text || this.text;

    if (this.isTerminal) {
      process.stdout.write(`\r${chalk.bold.yellow("⚠")} ${message}\n`);
    } else {
      console.log(`⚠ ${message}`);
    }
  }

  async pause(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    if (this.isTerminal) {
      clearLine();
    }
  }

  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    this.isRunning = false;
    if (this.isTerminal) {
      clearLine();
    }
  }

  async clear(): Promise<void> {
    await this.stop();
  }
}

/**
 * Display a formatted boxed message with title and optional styling
 */
export function displayBox(
  message: string,
  title?: string,
  options?: BoxenOptions,
): void {
  const defaultOptions: BoxenOptions = {
    padding: 1,
    margin: 1,
    borderStyle: "round",
    borderColor: "blue",
    title: title,
    titleAlignment: "center",
  };

  console.log(boxen(message, { ...defaultOptions, ...options }));
}

/**
 * Displays a large ASCII art title with colored text
 */
export function displayBanner(text: string, font?: string): void {
  const figletText = figlet.textSync(text, {
    font: (font || "Standard") as any,
  });
  console.log(chalk.blue(figletText));
}

/**
 * Displays a success message with green coloring and a checkmark
 */
export function success(message: string): void {
  console.log(`${chalk.green.bold("✓")} ${message}`);
}

/**
 * Displays an error message with red coloring and an X
 */
export function error(message: string): void {
  console.log(`${chalk.red.bold("✗")} ${chalk.red(message)}`);
}

/**
 * Displays a warning message with yellow coloring and a warning symbol
 */
export function warning(message: string): void {
  console.log(`${chalk.yellow.bold("⚠")} ${chalk.yellow(message)}`);
}

/**
 * Displays an info message with blue coloring and an info symbol
 */
export function info(message: string): void {
  console.log(`${chalk.blue.bold("ℹ")} ${message}`);
}

/**
 * Display a section header with a colored underline
 */
export function header(text: string): void {
  console.log("");
  console.log(chalk.bold.blue(text));
  console.log(chalk.blue("─".repeat(text.length)));
}

/**
 * Format a key-value pair for display, with the key in a different color
 */
export function keyValue(
  key: string,
  value: string | number | boolean,
): string {
  return `${chalk.cyan(key)}: ${value}`;
}
