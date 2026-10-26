/** Read one terminal line without echo; restore the TTY on every exit path. */
export async function readHiddenLine(prompt: string): Promise<string> {
  const input = process.stdin;
  const wasRaw = input.isRaw ?? false;
  const wasFlowing = input.readableFlowing;
  return await new Promise<string>((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onInterrupt);
      input.setRawMode(wasRaw);
      if (!wasFlowing) input.pause();
      process.stderr.write("\n");
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onInterrupt = () => onError(new Error("Passphrase input cancelled"));
    const onEnd = () => onError(new Error("Passphrase input ended before confirmation"));
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\u0003" || char === "\u0004") { onInterrupt(); return; }
        if (char === "\r" || char === "\n") { cleanup(); resolve(value); return; }
        if (char === "\u007f" || char === "\b") value = [...value].slice(0, -1).join("");
        else if (char >= " " && char !== "\u001b") value += char;
      }
    };
    input.setEncoding("utf8");
    input.setRawMode(true);
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onInterrupt);
    input.resume();
    process.stderr.write(prompt);
  });
}

export async function readConfirmedPassphrase(): Promise<string> {
  const passphrase = await readHiddenLine("Enter new owner passphrase (min 12 chars): ");
  const confirmation = await readHiddenLine("Confirm owner passphrase: ");
  if (passphrase !== confirmation) throw new Error("Passphrases do not match");
  return passphrase;
}
