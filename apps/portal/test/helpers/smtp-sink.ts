// Minimal SMTP server for tests: accepts every message and keeps it in memory.
// Enough for nodemailer without TLS or auth; it advertises no extensions.
import { createServer, type AddressInfo, type Server } from "node:net";

export type SinkMessage = { to: string[]; data: string };

export async function startSmtpSink(): Promise<{ url: string; messages: SinkMessage[]; close: () => Promise<void> }> {
  const messages: SinkMessage[] = [];
  const server: Server = createServer((socket) => {
    let buffer = "";
    let inData = false;
    let current: SinkMessage = { to: [], data: "" };
    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply("220 sink ready");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            messages.push(current);
            current = { to: [], data: "" };
            reply("250 queued");
          } else {
            current.data += `${line.startsWith("..") ? line.slice(1) : line}\n`;
          }
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO" || verb === "HELO") reply("250 sink");
        else if (verb === "MAIL") reply("250 ok");
        else if (verb === "RCPT") {
          current.to.push(/<([^>]*)>/.exec(line)?.[1] ?? "");
          reply("250 ok");
        } else if (verb === "DATA") {
          inData = true;
          reply("354 go ahead");
        } else if (verb === "QUIT") {
          reply("221 bye");
          socket.end();
        } else reply("250 ok");
      }
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `smtp://127.0.0.1:${port}`,
    messages,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
