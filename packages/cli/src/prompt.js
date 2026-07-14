import readline from 'node:readline';

/**
 * True only when we can actually run an interactive prompt — which needs BOTH
 * a TTY stdin (to read keystrokes) and a TTY stdout (so the prompt is visible
 * and unbuffered). Under `npm run`, stdout is often a pipe; requiring both
 * avoids silently buffering invisible prompts — the CLI then asks for flags
 * instead. Run `gemme create-user` directly in a terminal to be prompted.
 */
export function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Create a prompter backed by a single readline interface, reused for a whole
 * sequence of questions. Using one interface (rather than opening/closing one
 * per question) avoids fragile stdin state and the class of bug where closing
 * mid-answer clobbers the result. Injectable streams make it testable.
 *
 * @param {object} [opts]
 * @param {NodeJS.ReadableStream} [opts.input]
 * @param {NodeJS.WritableStream} [opts.output]
 */
export function createPrompter({ input = process.stdin, output = process.stdout } = {}) {
  const rl = readline.createInterface({ input, output });
  let muted = false;

  // Suppress echo of typed characters while a hidden question is active. The
  // question text itself is written before muting, so it still shows.
  rl._writeToOutput = (str) => {
    if (muted) {
      if (/[\r\n]/.test(str)) output.write('\n');
      return;
    }
    output.write(str);
  };

  return {
    ask(question) {
      return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
    },
    askHidden(question) {
      return new Promise((resolve) => {
        rl.question(question, (answer) => {
          muted = false;
          resolve(answer);
        });
        muted = true; // mute only after the question text has been written
      });
    },
    close() {
      rl.close();
    },
  };
}
